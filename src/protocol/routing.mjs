// 多账号调度:把「先耗尽一个账号再换下一个」的串行轮转换成**水位均衡 + 滞留**。
//
// 旧的 selection 只看列表顺序:第一个启用账号一直承接到 402/429 为止 ——
// 结果是 A 被抽干、B/C 全程闲置,想换还得手工点「切到此账号」。
//
// 均衡模式(balanced,默认)的规则:
//   1. 让位:任一额度窗口(5 小时滚动 / 周)剩余比例低于保留水位(routingReservePct,
//      默认 15%),或按当前消耗速度推算「窗口结束前会撞顶」的账号,降为备选 ——
//      只有没有更宽裕的账号时才用它,避免明知要 429 还硬打一发。
//   2. 水位:健康账号按**剩余比例从高到低**排 —— 谁最宽裕先给谁,几个账号的剩余量
//      被拉平,不会出现「A 抽干、B/C 满着」。
//   3. 滞留:为了不破坏上游的 prompt 缓存(每个账号一套独立的会话/指纹,频繁换号=
//      每次都是冷缓存),只要**上一个用过的账号**的剩余量没比其他账号少出一个滞回带
//      (routingHysteresisPct,默认 10 个百分点),就继续用它。于是表现为「一批请求
//      压在一个账号上,等它的余量掉下来再整体挪到下一个」,而不是每笔请求换一次号。
//   4. 无数据兜底:还没拉到用量快照时没有水位可比,退化为 LRU 分摊(最久未用优先)。
//
// 这里只做纯计算(不读库、不发请求):调用方把候选与用量快照递进来,
// 便于单测与「同一请求内多次轮转」复用。
export const WINDOW_MS = { fiveHour: 5 * 3600_000, weekly: 7 * 86400_000 };

// 用量快照的保质期:超过这个年龄就不拿它当判断依据。上游计费接口连续失败时,
// 三天前的「这个账号还很宽裕」不能继续指挥流量 —— 过期后退回「没有数据」,
// 由 LRU 分摊 + 429 轮转兜底。
export const SNAPSHOT_TTL_MS = 30 * 60_000;

/** 快照是否还能当判断依据(fetchedAt 缺失/为 0 视为不可用)。 */
export function isSnapshotFresh(fetchedAt, now = Date.now()) {
  const at = Number(fetchedAt) || 0;
  return at > 0 && now - at <= SNAPSHOT_TTL_MS;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 单个额度窗口的剩余量。返回 null 表示该窗口没有可用数据(cap 缺失/为 0)。
 */
export function windowHeadroom(name, limit, now = Date.now()) {
  if (!limit || typeof limit !== 'object') return null;
  const cap = num(limit.cap);
  const used = num(limit.used);
  if (cap <= 0) return null;
  const frac = (cap - used) / cap; // 剩余比例,可为负(已超额)
  const resetAt = num(limit.resetAt);
  let atRisk = limit.exceeded === true || frac <= 0;
  // 外推:窗口已过去一段时,按当前速度线性推演到 resetAt,接近撞顶就提前让位。
  // 窗口只过去不到 1 分钟时不外推(样本太小,一次突发就会误判)。
  let projected = used;
  if (!atRisk && resetAt > now) {
    const span = WINDOW_MS[name] ?? 0;
    const elapsed = span ? Math.max(0, span - (resetAt - now)) : 0;
    if (span && elapsed >= 60_000) {
      projected = used + (used / elapsed) * (resetAt - now);
      if (projected >= cap * 0.95) atRisk = true;
    }
  }
  return { window: name, used, cap, frac, resetAt, projected, atRisk };
}

/**
 * 账号整体余量:取所有已知窗口里最紧的那一个(木桶短板),
 * 再加月度信用余额作为补充判据。
 */
export function accountHeadroom(data, now = Date.now(), reserveFrac = 0) {
  const windows = [];
  for (const name of ['fiveHour', 'weekly']) {
    const h = windowHeadroom(name, data?.windowLimits?.[name], now);
    if (h) windows.push(h);
  }
  const credits = data?.credits;
  const creditFrac = credits && num(credits.monthlyTotal) > 0
    ? Math.max(0, num(credits.monthly) / num(credits.monthlyTotal))
    : null;
  const tightest = windows.slice().sort((a, b) => a.frac - b.frac)[0] ?? null;
  const frac = tightest ? tightest.frac : creditFrac;
  const known = frac != null;
  const atRisk = windows.some(w => w.atRisk)
    || (known && frac <= reserveFrac)
    || (creditFrac != null && creditFrac <= 0.05);
  return {
    known,
    frac,
    creditFrac,
    atRisk,
    window: tightest?.window ?? null,
    until: tightest?.resetAt ?? null,
    windows,
  };
}

/**
 * 候选排序(第一项即本次首选)。rows: [{ id, lastUsedAt, data }],
 * data 为 account-usage 的用量快照(可为 null)。
 */
export function rankAccounts(rows, {
  now = Date.now(), reservePct = 15, hysteresisPct = 10, sticky = true,
} = {}) {
  const reserveFrac = Math.max(0, Math.min(100, num(reservePct))) / 100;
  const hyst = Math.max(0, num(hysteresisPct)) / 100;
  const scored = rows.map(row => {
    const head = accountHeadroom(row.data, now, reserveFrac);
    return { ...row, head, atRisk: head.atRisk, lastUsedAt: num(row.lastUsedAt) };
  });
  const healthy = scored.filter(r => !r.atRisk);
  // 将满的账号:越宽裕越靠前(只有在健康账号都被跳过时才用得上)
  const risky = scored.filter(r => r.atRisk)
    .sort((a, b) => (b.head.frac ?? -1) - (a.head.frac ?? -1) || a.lastUsedAt - b.lastUsedAt || a.id - b.id);

  const known = healthy.filter(r => r.head.known && r.head.frac != null);
  let order;
  if (known.length === 0) {
    // 没有任何用量数据:LRU 分摊,先给最久没用的
    order = healthy.slice().sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id - b.id);
  } else {
    // 水位:最宽裕的优先(把几个账号的剩余量往下拉平)
    order = healthy.slice().sort((a, b) => {
      const fa = a.head.frac ?? 0, fb = b.head.frac ?? 0;
      return fb - fa || a.lastUsedAt - b.lastUsedAt || a.id - b.id;
    });
    if (sticky) {
      const last = healthy.reduce((a, b) => (b.lastUsedAt > a.lastUsedAt ? b : a), healthy[0]);
      const maxFrac = Math.max(...known.map(r => r.head.frac));
      // 滞留:上一个账号还没比最宽裕的那个「少花出」一个滞回带,就接着用它(保住上游缓存)。
      // lastUsedAt=0 表示从没用过,没有滞留可言。
      if (last && last.lastUsedAt > 0 && last.head.frac != null && last.head.frac >= maxFrac - hyst) {
        order = [last, ...order.filter(r => r.id !== last.id)];
      }
    }
  }
  return [...order, ...risky];
}

/** 调度模式归一化:只认 balanced / sticky,其余值(含空值)按均衡处理。 */
export function normalizeRoutingMode(mode) {
  return mode === 'sticky' ? 'sticky' : 'balanced';
}

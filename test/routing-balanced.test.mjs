// 均衡调度(routingMode=balanced)的契约测试。
// 上层:纯函数部分(窗口余量/外推/水位排序/滞留带)用固定时间戳直接断言,
// 不依赖时钟;下层:三个账号喂不同用量快照,验证真实转发确实落在「最宽裕」的账号上,
// 而不是像旧行为那样钉在列表第一个。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowHeadroom, accountHeadroom, rankAccounts, normalizeRoutingMode,
} from '../src/protocol/routing.mjs';
import { setup } from './helpers.mjs';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const win = (used, cap, extra = {}) => ({ used, cap, exceeded: false, resetAt: 0, ...extra });
const usage = (fiveHour, weekly = null, credits = null) => ({
  windowLimits: { fiveHour, weekly },
  credits,
});

// ── 纯函数 ────────────────────────────────────────────────
test('routing: 窗口余量按 cap/used 计算,cap 缺失或无数据返回 null', () => {
  assert.equal(windowHeadroom('fiveHour', null, NOW), null);
  assert.equal(windowHeadroom('fiveHour', win(1, 0), NOW), null);
  const h = windowHeadroom('fiveHour', win(1, 4), NOW);
  assert.equal(h.frac, 0.75);
  assert.equal(h.atRisk, false);
  assert.equal(windowHeadroom('fiveHour', win(4, 4), NOW).atRisk, true);
  assert.equal(windowHeadroom('weekly', win(5, 6, { exceeded: true }), NOW).atRisk, true);
});

test('routing: 消耗速度外推 —— 窗口走完前会撞顶的账号提前降级', () => {
  // 5 小时窗口已过 1 小时(剩 4 小时),用掉 2/3:线性外推 2 + 2*4 = 10 > 3
  const resetAt = NOW + 4 * 3600_000;
  const h = windowHeadroom('fiveHour', win(2, 3, { resetAt }), NOW);
  assert.equal(h.atRisk, true);
  assert.ok(h.projected > 3);
  // 刚过 30 秒不采样:避免一次突发就误判
  const early = windowHeadroom('fiveHour', win(2, 3, { resetAt: NOW + 5 * 3600_000 - 30_000 }), NOW);
  assert.equal(early.atRisk, false);
});

test('routing: 账号余量取最紧的窗口,月度信用余额作为补充', () => {
  const h = accountHeadroom(usage(win(3, 4), win(1, 6)), NOW, 0);
  assert.equal(h.window, 'fiveHour');
  assert.equal(h.frac, 0.25);
  assert.equal(h.known, true);
  assert.equal(accountHeadroom(null, NOW, 0).known, false);
  // 只剩 3% 月度信用 → 视为将满,即便窗口数据缺失
  const creditOnly = accountHeadroom({ windowLimits: null, credits: { monthly: 3, monthlyTotal: 100 } }, NOW, 0.15);
  assert.equal(creditOnly.atRisk, true);
});

test('routing: 没有用量数据时按 LRU 分摊(最久未用优先)', () => {
  const ranked = rankAccounts([
    { id: 1, lastUsedAt: 300, data: null },
    { id: 2, lastUsedAt: 100, data: null },
    { id: 3, lastUsedAt: 0, data: null },
  ], { now: NOW });
  assert.deepEqual(ranked.map(r => r.id), [3, 2, 1]);
});

test('routing: 有数据时水位优先 —— 最宽裕的先给,而不是列表第一个', () => {
  const ranked = rankAccounts([
    { id: 1, lastUsedAt: 0, data: usage(win(3, 4)) },   // 剩 25%
    { id: 2, lastUsedAt: 0, data: usage(win(1, 4)) },   // 剩 75%
    { id: 3, lastUsedAt: 0, data: usage(win(2, 4)) },   // 剩 50%
  ], { now: NOW });
  assert.deepEqual(ranked.map(r => r.id), [2, 3, 1]);
});

test('routing: 滞留带 —— 上一个账号余量没掉出滞回带就继续用它', () => {
  const rows = [
    { id: 1, lastUsedAt: 1000, data: usage(win(2, 10)) }, // 剩 80%(刚用过)
    { id: 2, lastUsedAt: 500, data: usage(win(1, 10)) },  // 剩 90%(最宽裕)
  ];
  // 差距 10pp 正好在默认滞回带内 → 沿用上一个
  assert.deepEqual(rankAccounts(rows, { now: NOW }).map(r => r.id), [1, 2]);
  // 差距超出滞回带 → 切到更宽裕的
  assert.deepEqual(rankAccounts(rows, { now: NOW, hysteresisPct: 5 }).map(r => r.id), [2, 1]);
  // 关掉滞留 = 纯水位
  assert.deepEqual(rankAccounts(rows, { now: NOW, sticky: false }).map(r => r.id), [2, 1]);
  // 从没用过的账号不参与滞留判断(LRU 语义)
  const fresh = [
    { id: 1, lastUsedAt: 0, data: usage(win(1, 10)) },
    { id: 2, lastUsedAt: 0, data: usage(win(2, 10)) },
  ];
  assert.deepEqual(rankAccounts(fresh, { now: NOW }).map(r => r.id), [1, 2]);
});

test('routing: 将满账号(低于预留水位)排在最后,只有全都将满时才用它', () => {
  const ranked = rankAccounts([
    { id: 1, lastUsedAt: 0, data: usage(win(4, 4, { exceeded: false })) }, // 剩 0% → 风险
    { id: 2, lastUsedAt: 0, data: usage(win(2, 4)) },                      // 剩 50%
  ], { now: NOW, reservePct: 15 });
  assert.deepEqual(ranked.map(r => r.id), [2, 1]);
  const allRisky = rankAccounts([
    { id: 1, lastUsedAt: 0, data: usage(win(4, 4)) },
    { id: 2, lastUsedAt: 0, data: usage(win(3.5, 4)) },
  ], { now: NOW, reservePct: 15 });
  assert.deepEqual(allRisky.map(r => r.id), [2, 1], '全都将满时仍优先更宽裕的');
});

test('routing: 调度模式只认 balanced / sticky', () => {
  assert.equal(normalizeRoutingMode(undefined), 'balanced');
  assert.equal(normalizeRoutingMode('balanced'), 'balanced');
  assert.equal(normalizeRoutingMode('sticky'), 'sticky');
  assert.equal(normalizeRoutingMode('other'), 'balanced');
});

// ── 端到端:三个账号,用量不同,请求落在最宽裕的账号上 ──────────
const KEY_A = 'user_bal_a_almost_full';
const KEY_B = 'user_bal_b_half';
const KEY_C = 'user_bal_c_empty';
// key → fiveHour used(总 cap 4):A 3.8(剩 5%,低于预留) B 2(剩 50%) C 0(剩 100%)
const usedByKey = new Map([[KEY_A, 3.8], [KEY_B, 2], [KEY_C, 0]]);

test('balanced: 请求优先落在余量最大的账号,抽干后自动换人,无需手工切换', async () => {
  const s = await setup({
    onRequest(req, res) {
      const key = String(req.headers.authorization || '').replace('Bearer ', '');
      if (req.url.startsWith('/alpha/whoami')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: { userName: `acct-${key.slice(-3)}` } }));
        return false;
      }
      if (req.url.startsWith('/alpha/billing/credits')) {
        const used = usedByKey.get(key) ?? 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
          windowLimits: {
            limited: false, exceeded: false,
            fiveHour: { used, cap: 4, exceeded: used >= 4, resetAt: 0 },
            weekly: { used: 1, cap: 20, exceeded: false, resetAt: 0 },
          },
        }));
        return false;
      }
      if (req.url.startsWith('/alpha/billing/subscriptions') || req.url.startsWith('/alpha/usage/summary')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { planId: 'individual-pro', status: 'active' }, totalCount: 0 }));
        return false;
      }
      return; // /alpha/generate 走默认成功应答
    },
  });
  const send = () => s.proxy.post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  const usedKeys = () => s.mock.seen.filter(r => r.url === '/alpha/generate')
    .map(r => String(r.headers.authorization).replace('Bearer ', ''));
  try {
    for (const [i, apiKey] of [KEY_A, KEY_B, KEY_C].entries()) {
      const r = await s.proxy.post('/admin/api/upstream-keys', { name: `Account ${i + 1}`, apiKey });
      assert.equal(r.status, 201);
    }
    await fetch(s.proxy.base + '/admin/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: KEY_A, accountUsageRefreshMs: 0 }),
    });
    // 拉一次用量快照,调度器才知道谁宽裕
    const refreshed = await (await s.proxy.post('/admin/api/account-usage/refresh', {})).json();
    assert.equal(refreshed.refreshed, 3);
    const snap = await (await s.proxy.get('/admin/api/account-usage')).json();
    assert.equal(snap.routing.mode, 'balanced');
    assert.equal(snap.routing.reservePct, 15);
    assert.ok(snap.rows.every(r => r.headroom.known));

    // 第一笔:A 剩 5%(低于预留)必须跳过 → C(剩 100%)
    assert.equal((await send()).status, 200);
    assert.deepEqual(usedKeys(), [KEY_C]);

    // 第二笔:C 仍是余量最大的(数据未刷新),滞留规则继续用它
    assert.equal((await send()).status, 200);
    assert.deepEqual(usedKeys(), [KEY_C, KEY_C]);

    // 把 C 也打掉(剩 25%),刷新后 B(剩 50%)成为最宽裕的
    usedByKey.set(KEY_C, 3);
    await s.proxy.post('/admin/api/account-usage/refresh', {});
    assert.equal((await send()).status, 200);
    assert.equal(usedKeys().at(-1), KEY_B, '自动换到更宽裕的账号,无需手工切换');

    // 手工固定仍然优先(临时指定的场景):把余量最低的 A 钉住,请求就得走 A;
    // 清掉后回到均衡
    const rows = snap.rows;
    const a = rows.find(r => r.name === 'Account 1');
    const pinned = await (await s.proxy.post('/admin/api/account-usage/pin', { id: a.id })).json();
    assert.equal(pinned.routing.pinned, a.id);
    assert.equal((await send()).status, 200);
    assert.equal(usedKeys().at(-1), KEY_A, '固定优先级高于均衡策略');
    const unpinned = await (await s.proxy.post('/admin/api/account-usage/pin', { id: null })).json();
    assert.equal(unpinned.routing.pinned, null);
  } finally { await s.close(); }
});

// 「按客户端绑定亲和」与「快照过期」的契约测试。
// 亲和是给多租户的:每个客户端绑定自己的账号,互不挤占;关掉(默认)则所有客户端
// 共用一套均衡。快照过期是给上游计费接口挂掉时留的后路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { isSnapshotFresh, SNAPSHOT_TTL_MS } from '../src/protocol/routing.mjs';

const KEY_A = 'user_aff_a_full';
const KEY_B = 'user_aff_b_half';
const KEY_C = 'user_aff_c_empty';
const KEY_BROKEN = 'user_aff_broken';
// fiveHour cap 固定 4;used 决定余量:A 剩 5%(低于 15% 预留)、B 剩 50%、C 剩 100%
const usedByKey = new Map([[KEY_A, 3.8], [KEY_B, 2], [KEY_C, 0]]);

function upstream(req, res) {
  const key = String(req.headers.authorization || '').replace('Bearer ', '');
  const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (key === KEY_BROKEN) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'billing backend down' }));
  }
  if (req.url.startsWith('/alpha/whoami')) return json({ user: { userName: `acct-${key.slice(-1)}` } });
  if (req.url.startsWith('/alpha/billing/credits')) {
    const used = usedByKey.get(key) ?? 0;
    return json({
      credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: false, exceeded: used >= 4,
        fiveHour: { used, cap: 4, exceeded: used >= 4, resetAt: 0 },
        weekly: { used: 1, cap: 40, exceeded: false, resetAt: 0 },
      },
    });
  }
  if (req.url.startsWith('/alpha/billing/subscriptions') || req.url.startsWith('/alpha/usage/summary')) {
    return json({ data: { planId: 'individual-pro', status: 'active' }, totalCount: 0 });
  }
  return undefined; // /alpha/generate 走默认应答
}

test('快照过期:超过 30 分钟就不再当判断依据', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(isSnapshotFresh(now - 1000, now), true);
  assert.equal(isSnapshotFresh(now - SNAPSHOT_TTL_MS + 1000, now), true);
  assert.equal(isSnapshotFresh(now - SNAPSHOT_TTL_MS - 1000, now), false);
  assert.equal(isSnapshotFresh(now - 3 * 24 * 3600_000, now), false, '三天前的快照必须失效');
  assert.equal(isSnapshotFresh(0, now), false, '没有抓取时间等于没有数据');
  assert.equal(isSnapshotFresh(null, now), false);
});

async function makeWorld(options = {}) {
  // 用量表是模块级的:每个用例开头复位,避免上一个用例改过的水位漏到下一个
  usedByKey.set(KEY_A, 3.8); usedByKey.set(KEY_B, 2); usedByKey.set(KEY_C, 0);
  const s = await setup({ onRequest: upstream, cwd: options.cwd });
  const addKey = async (name, apiKey) => {
    const r = await s.proxy.post('/admin/api/upstream-keys', { name, apiKey });
    assert.equal(r.status, 201);
    return (await r.json()).id ?? (await r.json()).key?.id;
  };
  const ids = {};
  ids.a = await addKey('Account A', KEY_A);
  ids.b = await addKey('Account B', KEY_B);
  ids.c = await addKey('Account C', KEY_C);
  ids.broken = await addKey('Account Broken', KEY_BROKEN);
  await fetch(s.proxy.base + '/admin/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: KEY_A, accountUsageRefreshMs: 0 }),
  });
  const addClient = async (name, upstreamKeyId) => {
    const r = await s.proxy.post('/admin/api/client-keys', { name, upstreamKeyId });
    assert.equal(r.status, 201);
    return (await r.json()).token;
  };
  const send = async token => {
    const before = s.mock.seen.filter(x => x.url === '/alpha/generate').length;
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: 'Bearer ' + token });
    await r.text();
    const after = s.mock.seen.filter(x => x.url === '/alpha/generate').slice(before);
    return { status: r.status, keys: after.map(x => String(x.headers.authorization).replace('Bearer ', '')) };
  };
  const refresh = async () => {
    const r = await (await s.proxy.post('/admin/api/account-usage/refresh', {})).json();
    assert.ok(r.refreshed >= 3);
  };
  const setMode = async patch => {
    await fetch(s.proxy.base + '/admin/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  };
  return { s, ids, addKey, addClient, send, refresh, setMode };
}

test('默认(无亲和):客户端绑定 B,请求照样落到最宽裕的 C', async () => {
  const w = await makeWorld();
  try {
    const ck = await w.addClient('tenant-1', w.ids.b);
    await w.refresh();
    assert.equal((await w.send(ck)).keys.at(-1), KEY_C, '均衡优先于绑定');
  } finally { await w.s.close(); }
});

test('开启亲和:两个客户端各自绑定的健康账号互不挤占', async () => {
  const w = await makeWorld();
  try {
    await w.setMode({ routingAffinity: true });
    const t1 = await w.addClient('tenant-1', w.ids.b);  // B 剩 50%,健康
    const t2 = await w.addClient('tenant-2', w.ids.c);  // C 剩 100%,健康
    await w.refresh();
    assert.equal((await w.send(t1)).keys.at(-1), KEY_B, 'tenant-1 用自己绑定的 B');
    assert.equal((await w.send(t2)).keys.at(-1), KEY_C, 'tenant-2 用自己绑定的 C');
    // 互不影响:再打一轮,两人仍然各在各的账号上
    assert.equal((await w.send(t1)).keys.at(-1), KEY_B);
    assert.equal((await w.send(t2)).keys.at(-1), KEY_C);
  } finally { await w.s.close(); }
});

test('亲和不是死绑:绑定账号掉到预留水位以下就自动让位', async () => {
  const w = await makeWorld();
  try {
    await w.setMode({ routingAffinity: true });
    const t1 = await w.addClient('tenant-1', w.ids.b);
    await w.refresh();
    assert.equal((await w.send(t1)).keys.at(-1), KEY_B);
    usedByKey.set(KEY_B, 3.9);           // B 只剩 2.5%,低于 15% 预留
    await w.refresh();
    assert.equal((await w.send(t1)).keys.at(-1), KEY_C, '绑定账号将满 → 退回均衡');
  } finally { await w.s.close(); }
});

test('亲和只在「有余量数据」时成立:绑定账号数据拉不到就走均衡', async () => {
  const w = await makeWorld();
  try {
    await w.setMode({ routingAffinity: true });
    const t1 = await w.addClient('tenant-1', w.ids.broken);
    await w.refresh();                    // broken 账号的 billing 500,拿不到数据
    const snap = await (await w.s.proxy.get('/admin/api/account-usage')).json();
    const brokenRow = snap.rows.find(r => r.id === w.ids.broken);
    assert.equal(brokenRow.headroom.known, false);
    assert.equal((await w.send(t1)).keys.at(-1), KEY_C, '没有数据就没有亲和,走均衡');
  } finally { await w.s.close(); }
});

test('亲和不影响固定账号与受限账号:固定优先,耗尽账号仍被跳过', async () => {
  const w = await makeWorld();
  try {
    await w.setMode({ routingAffinity: true });
    const t1 = await w.addClient('tenant-1', w.ids.b);
    await w.refresh();
    // 固定到 A(A 剩 5%,低于水位)→ 固定压过亲和,请求仍走 A
    await w.s.proxy.post('/admin/api/account-usage/pin', { id: w.ids.a });
    assert.equal((await w.send(t1)).keys.at(-1), KEY_A, '固定优先于亲和与均衡');
    await w.s.proxy.post('/admin/api/account-usage/pin', { id: null });
    // 恢复后回到绑定账号 B
    assert.equal((await w.send(t1)).keys.at(-1), KEY_B);
  } finally { await w.s.close(); }
});

test('快照过期后不再指挥流量:重启进程读到的是两小时前的数据,应按无数据处理', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { DatabaseSync } = await import('node:sqlite');
  const { startProxy } = await import('./helpers.mjs');
  // 自己管数据目录:代理被 kill 时不会把库删掉,后面还要在原库上改时间戳
  const dir = mkdtempSync(join(tmpdir(), 'ccp-stale-'));
  const w = await makeWorld({ cwd: dir });
  try {
    const ck = await w.addClient('tenant-stale', w.ids.a);
    await w.refresh();                        // 落库 + 进缓存:C 剩 100% 最宽裕
    assert.equal((await w.send(ck)).keys.at(-1), KEY_C);

    await w.s.proxy.kill();                   // 先停进程释放库锁,缓存也随之清空
    const db = new DatabaseSync(join(dir, 'ccp.db'));
    db.prepare('UPDATE account_usage_snapshot SET fetched_at = fetched_at - ?').run(2 * 3600_000);
    const aged = db.prepare('SELECT COUNT(*) c FROM account_usage_snapshot').get().c;
    db.close();
    assert.ok(aged >= 3, '快照应已落库');

    const proxy = await startProxy({ upstreamPort: w.s.mock.port, cwd: dir });
    try {
      // 无数据 → LRU:A/B 从未被用过(并列)按 id 升序 → A;若还认陈旧快照就会选 C
      const before = w.s.mock.seen.filter(x => x.url === '/alpha/generate').length;
      const r = await proxy.post('/v1/chat/completions',
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        { Authorization: 'Bearer ' + ck });
      await r.text();
      const used = w.s.mock.seen.filter(x => x.url === '/alpha/generate').slice(before)
        .map(x => String(x.headers.authorization).replace('Bearer ', ''));
      assert.equal(r.status, 200);
      assert.equal(used.at(-1), KEY_A, '陈旧快照作废后按 LRU 选,而不是继续信两小时前的「C 还满着」');
    } finally { await proxy.kill(); }
  } finally {
    await w.s.mock.close().catch(() => {});
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

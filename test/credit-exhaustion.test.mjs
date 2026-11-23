// 低额度持久耗尽测试:月度信用只剩零头时,上游会把「额度用完」报成 429 USAGE_EXCEEDED
// 而不是 402。若只做 10 分钟窗口冷却,到期后同一账号又会被选中、再撞一次再轮转,
// 等于每笔请求都白跑一个来回。本文件验证:
//   1) 低额度 + 429 耗尽 → 账号持久标记 exhausted(落库),当次请求仍轮转到备用账号成功;
//   2) 额度恢复(>=5%)后,用量刷新自动把该账号重新启用(仅限低额度路径标记的账号)。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockUpstream, startProxy } from './helpers.mjs';

process.env.CCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccp-credit-'));
process.on('exit', () => { try { rmSync(process.env.CCP_DATA_DIR, { recursive: true, force: true }); } catch {} });
const { SCHEMA } = await import('../src/store/db.mjs');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const KEY_A = 'user_credit_a_low____1';
const KEY_B = 'user_credit_b_ok_____2';

let monthlyCredits = 0.07; // individual-go 月度总额 $10 → 0.7%,低于 1% 阈值
let quotaHit = true;       // A 是否回 429 USAGE_EXCEEDED(模拟月额度耗尽)

const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const mock = await startMockUpstream({
  onRequest: (req, res) => {
    const auth = req.headers['authorization'];
    if (req.url.startsWith('/alpha/billing/credits')) {
      json(res, {
        credits: { monthlyCredits, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {
          limited: true,
          fiveHour: { used: 0, cap: 3, exceeded: false, resetAt: 0 },
          weekly: { used: 1, cap: 6, exceeded: false, resetAt: 0 },
        },
      });
      return false;
    }
    if (req.url.startsWith('/alpha/billing/subscriptions')) {
      json(res, { data: {
        planId: 'individual-go', status: 'active',
        currentPeriodStart: '2026-11-01T00:00:00Z', currentPeriodEnd: '2026-12-01T00:00:00Z',
      } });
      return false;
    }
    if (req.url.startsWith('/alpha/whoami')) { json(res, { user: { userName: 'credit-test' } }); return false; }
    if (req.url.startsWith('/alpha/usage/summary')) { json(res, {}); return false; }
    if (quotaHit && auth === `Bearer ${KEY_A}`) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'USAGE_EXCEEDED', message: 'monthly usage exhausted' } }));
      return false;
    }
    return; // /alpha/generate 走默认正常应答
  },
});

const workdir = mkdtempSync(join(tmpdir(), 'ccp-credit-proxy-'));
// 顺序(绑定)模式:让 A 先承接,耗尽后轮转到 B,恢复后回到 A,断言更直接
writeFileSync(join(workdir, 'config.json'), '{"routingMode":"sticky"}');
const db = new DatabaseSync(join(workdir, 'ccp.db'));
db.exec(SCHEMA);
const token = 'sk-ccp-' + randomBytes(16).toString('hex');
db.prepare('INSERT INTO upstream_keys (name, api_key, status, created_at) VALUES (?,?,?,?)').run('账户A', KEY_A, 'active', Date.now());
db.prepare('INSERT INTO upstream_keys (name, api_key, status, created_at) VALUES (?,?,?,?)').run('账户B', KEY_B, 'active', Date.now());
db.prepare('INSERT INTO client_keys (name, key_hash, key_prefix, upstream_key_id, status, created_at) VALUES (?,?,?,?,?,?)')
  .run('zcode', sha256(token), token.slice(0, 16) + '…', 1, 'active', Date.now());
db.close();

const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
after(async () => {
  await proxy.kill();
  await mock.close();
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

const statusOf = (name) => {
  const d = new DatabaseSync(join(workdir, 'ccp.db'));
  const r = d.prepare('SELECT status FROM upstream_keys WHERE name = ?').get(name);
  d.close();
  return r.status;
};
const chat = () => proxy.post('/v1/chat/completions',
  { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
  { Authorization: `Bearer ${token}` });
const refreshAll = () => proxy.post('/admin/api/account-usage/refresh', {});

test('低额度 + 429 耗尽:账号持久标记 exhausted,当次请求轮转到备用账号', async () => {
  // 先拉一次用量快照,让轮转时能读到「月度信用 0.07/10」
  const r0 = await refreshAll();
  assert.equal(r0.status, 200);

  const r = await chat();
  assert.equal(r.status, 200, '轮转到备用账号后成功');
  await sleep(200);
  assert.equal(statusOf('账户A'), 'exhausted', '低额度账号被持久标记');
  assert.equal(statusOf('账户B'), 'active', '备用账号保持可用');
  assert.ok(mock.seen.some(s => s.headers['authorization'] === `Bearer ${KEY_A}`), 'A 被打过一次');
});

test('额度恢复后用量刷新自动重新启用,请求回到绑定账号', async () => {
  monthlyCredits = 8; // 恢复到 80%
  quotaHit = false;
  const r = await refreshAll();
  assert.equal(r.status, 200);
  await sleep(200);
  assert.equal(statusOf('账户A'), 'active', '额度恢复后自动重新启用');

  const chatR = await chat();
  assert.equal(chatR.status, 200);
});

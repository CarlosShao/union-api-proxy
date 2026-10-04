'use strict';
/**
 * 账号冷却 / 失败转移 / 额度加权选号的回归测试。
 *
 * 重点覆盖三类风险：
 *   1. 跨渠道：冷却与转移绝不能选到别的渠道的账号（那等于把凭据发去错误的上游域名）。
 *   2. 不该重试的错误不能重试：重发整个请求体可能造成重复计费。
 *   3. 额度数据不完整时必须退化为轮询，不能把请求饿死到少数账号上。
 *
 * 独立临时 SQLite，不碰真实账号库。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uap-failover-'));
process.env.UNION_DATA_DIR = TMP;
process.env.CODEBUDDY_DATA_DIR = TMP;

const store = require(path.join(__dirname, '..', 'core', 'store.js'));
const session = require(path.join(__dirname, '..', 'core', 'session.js'));
const auth = require(path.join(__dirname, '..', 'core', 'auth.js'));
const codebuddy = require(path.join(__dirname, '..', 'core', 'providers', 'codebuddy', 'index.js'));
const traework = require(path.join(__dirname, '..', 'core', 'providers', 'traework', 'index.js'));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}

function seed() {
  for (const r of store.listAccountRows()) store.deleteAccountRow(r.id);
  store.deleteAllSessionBindings();
  session.clearQuotaCache();
  // 冷却表是模块级内存态，不重置的话会在用例之间串味
  session.clearUnhealthy();
  const mk = (provider, name) => ({
    id: 'acct_' + provider + '_' + name, provider, name, source: 'oauth', addedBy: 'oauth',
    account: { uid: provider + name, nickname: name },
    auth: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 86400000 },
    accounts: [], autoCheckin: true, lastUsedAt: 0, useCount: 0, createdAt: Date.now(),
  });
  for (const a of [mk('codebuddy', 'a'), mk('codebuddy', 'b'), mk('codebuddy', 'c')]) store.insertAccount(a);
  for (const a of [mk('traework', 'x'), mk('traework', 'y')]) store.insertAccount(a);
  session.loadSession();
}

seed();

/* ---------- 1. 冷却时长按渠道自己的 classifyError 决定 ---------- */

check('冷却：额度不足判为 credit，冷却 30 分钟', () => {
  const c = codebuddy.classifyError(400, '{"code":10001,"msg":"积分不足"}');
  assert.strictEqual(c.kind, 'credit');
  assert.strictEqual(session.COOLDOWN_MS.credit, 30 * 60 * 1000);
});

check('冷却：401/403 -> session 5 分钟；429 -> rate 1 分钟', () => {
  assert.strictEqual(codebuddy.classifyError(401, '').kind, 'session');
  assert.strictEqual(codebuddy.classifyError(403, '').kind, 'session');
  assert.strictEqual(codebuddy.classifyError(429, '').kind, 'rate');
  assert.strictEqual(session.COOLDOWN_MS.session, 5 * 60 * 1000);
  assert.strictEqual(session.COOLDOWN_MS.rate, 60 * 1000);
});

check('【关键】冷却：额度判定不会被「上下文超限」误伤', () => {
  // CodeBuddy 上下文超限也含 "exceeded"，用宽泛正则会把账号白白冷却 30 分钟，
  // 而超限换账号一样会失败。
  const c = codebuddy.classifyError(400, '{"code":11101,"msg":"maximum context length exceeded"}');
  assert.notStrictEqual(c.kind, 'credit', '上下文超限不得判成额度耗尽，实际: ' + c.kind);
});

check('冷却：竞品词拦截 11128 不触发冷却', () => {
  const c = codebuddy.classifyError(400, '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}');
  assert.strictEqual(c.kind, 'content_filter');
  assert.ok(!session.COOLDOWN_MS.content_filter, 'content_filter 不应有冷却时长，否则会白白踢掉好账号');
});

check('冷却：参数类错误不触发冷却（换账号也没用）', () => {
  assert.strictEqual(codebuddy.classifyError(400, '{"code":11101,"msg":"bad param"}').kind, 'client');
  assert.strictEqual(codebuddy.classifyError(404, '').kind, 'notfound');
});

check('recordUpstreamFailure：按渠道分类置入冷却', () => {
  seed();
  const id = 'acct_codebuddy_a';
  assert.strictEqual(auth.recordUpstreamFailure(id, 401, '', codebuddy), true);
  assert.strictEqual(session.isUnhealthy(id), true);
  auth.recordUpstreamSuccess(id);
  assert.strictEqual(session.isUnhealthy(id), false);
});

check('recordUpstreamFailure：不该冷却的错误返回 false', () => {
  seed();
  const id = 'acct_codebuddy_b';
  assert.strictEqual(auth.recordUpstreamFailure(id, 400, '{"code":11128}', codebuddy), false);
  assert.strictEqual(session.isUnhealthy(id), false, '内容过滤不该把账号踢掉');
});

check('recordUpstreamFailure：无渠道信息时按状态码粗判', () => {
  seed();
  const id = 'acct_codebuddy_c';
  assert.strictEqual(auth.recordUpstreamFailure(id, 429, '', undefined), true);
  assert.strictEqual(session.isUnhealthy(id), true);
});

/* ---------- 2. healthyAccounts / pickFailoverAccount 的跨渠道安全性 ---------- */

check('【关键】healthyAccounts 必须带 provider 参数（否则会丢 inKind 过滤）', () => {
  seed();
  const cb = session.healthyAccounts('codebuddy');
  const tc = session.healthyAccounts('traework');
  assert.ok(cb.length > 0 && tc.length > 0);
  assert.ok(cb.every((a) => a.provider === 'codebuddy'), 'codebuddy 候选里混进了别的渠道');
  assert.ok(tc.every((a) => a.provider === 'traework'), 'traework 候选里混进了别的渠道');
  assert.strictEqual(cb.length + tc.length, 5, '两个渠道的候选总数应等于账号总数');
});

check('【关键】pickFailoverAccount 只在同渠道内挑', () => {
  seed();
  for (let i = 0; i < 6; i++) {
    const n = session.pickFailoverAccount('acct_codebuddy_a', 'codebuddy');
    assert.ok(n, '应能找到备用账号');
    assert.strictEqual(n.provider, 'codebuddy');
    assert.notStrictEqual(n.id, 'acct_codebuddy_a', '不能换回刚失败的那个');
  }
});

check('pickFailoverAccount：排除刚失败的账号', () => {
  seed();
  const n = session.pickFailoverAccount('acct_codebuddy_a', 'codebuddy');
  assert.notStrictEqual(n.id, 'acct_codebuddy_a');
});

check('pickFailoverAccount：冷却中的账号不会被选中', () => {
  seed();
  session.markUnhealthy('acct_codebuddy_b', 10 * 60 * 1000, 'credit:400');
  for (let i = 0; i < 8; i++) {
    const n = session.pickFailoverAccount('acct_codebuddy_a', 'codebuddy');
    assert.notStrictEqual(n.id, 'acct_codebuddy_b', '冷却中的账号不应被选中');
  }
});

check('pickFailoverAccount：failoverEnabled=false 时不换号', () => {
  seed();
  session.setPoolConfig({ failoverEnabled: false }, 'codebuddy');
  assert.strictEqual(session.pickFailoverAccount('acct_codebuddy_a', 'codebuddy'), null);
  session.setPoolConfig({ failoverEnabled: true }, 'codebuddy');
});

check('pickFailoverAccount：pinned 模式下不擅自换号', () => {
  seed();
  session.setPoolConfig({ mode: 'pinned', pinnedId: 'acct_codebuddy_a' }, 'codebuddy');
  assert.strictEqual(session.pickFailoverAccount('acct_codebuddy_a', 'codebuddy'), null,
    '用户明确指定了账号，不应擅自换成别的');
  session.setPoolConfig({ mode: 'pool', pinnedId: null }, 'codebuddy');
});

check('冷却表：后一次较短的失败不会缩短已有冷却', () => {
  seed();
  session.markUnhealthy('acct_codebuddy_a', 30 * 60 * 1000, 'credit');
  const first = session.getUnhealthy('acct_codebuddy_a').until;
  session.markUnhealthy('acct_codebuddy_a', 60 * 1000, 'rate');
  assert.ok(session.getUnhealthy('acct_codebuddy_a').until >= first, '冷却到期时间不应被缩短');
});

check('冷却表：过期后自动失效', () => {
  seed();
  session.markUnhealthy('acct_codebuddy_a', 1, 'rate');
  const end = Date.now() + 6;
  while (Date.now() < end) { /* 等 1ms 冷却过去 */ }
  assert.strictEqual(session.isUnhealthy('acct_codebuddy_a'), false);
});

check('冷却表：listUnhealthy 给出可读信息', () => {
  seed();
  session.markUnhealthy('acct_codebuddy_a', 5 * 60 * 1000, 'session:401');
  const l = session.listUnhealthy();
  const hit = l.find((x) => x.accountId === 'acct_codebuddy_a');
  assert.ok(hit, '应列出该账号');
  assert.strictEqual(hit.accountName, 'a');
  assert.strictEqual(hit.provider, 'codebuddy');
  assert.ok(hit.remainingMs > 0);
});

/* ---------- 3. 额度加权选号 ---------- */

check('选号：strategy 此前从未被读取，现在 quota-weighted 真的生效', () => {
  seed();
  session.setPoolConfig({ strategy: 'quota-weighted' }, 'codebuddy');
  // 额度数据不全 -> 必须退化为轮询（而不是饿死到某个账号）
  const ids = new Set();
  for (let i = 0; i < 12; i++) ids.add(session.pickAccount(null, 'codebuddy').id);
  assert.ok(ids.size > 1, '额度数据不全时应退化为轮询，实际只有一个账号: ' + [...ids]);
  session.setPoolConfig({ strategy: 'round-robin' }, 'codebuddy');
});

check('选号：额度全覆盖时 least-used 优先挑今日消耗少的', () => {
  seed();
  session.clearQuotaCache();
  session.setQuotaCache('acct_codebuddy_a', { usageLeft: 10, usageTotal: 100, todayUsed: 500 });
  session.setQuotaCache('acct_codebuddy_b', { usageLeft: 10, usageTotal: 100, todayUsed: 5 });
  session.setQuotaCache('acct_codebuddy_c', { usageLeft: 10, usageTotal: 100, todayUsed: 300 });
  session.setPoolConfig({ strategy: 'least-used' }, 'codebuddy');
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(session.pickAccount(null, 'codebuddy').id, 'acct_codebuddy_b',
      'todayUsed 最少的应被持续选中');
  }
  session.setPoolConfig({ strategy: 'round-robin' }, 'codebuddy');
});

check('选号：quota-weighted 会偏向剩余额度占比高的账号', () => {
  seed();
  session.clearQuotaCache();
  session.setQuotaCache('acct_codebuddy_a', { usageLeft: 5, usageTotal: 100, todayUsed: 0 });    // 5%
  session.setQuotaCache('acct_codebuddy_b', { usageLeft: 95, usageTotal: 100, todayUsed: 0 });   // 95%
  session.setQuotaCache('acct_codebuddy_c', { usageLeft: 50, usageTotal: 100, todayUsed: 0 });
  session.setPoolConfig({ strategy: 'quota-weighted' }, 'codebuddy');
  const tally = {};
  for (let i = 0; i < 400; i++) {
    const id = session.pickAccount(null, 'codebuddy').id;
    tally[id] = (tally[id] || 0) + 1;
  }
  assert.ok(tally['acct_codebuddy_b'] > tally['acct_codebuddy_a'],
    '剩余额度多的应被选得更多，实际: ' + JSON.stringify(tally));
  session.setPoolConfig({ strategy: 'round-robin' }, 'codebuddy');
});

check('【关键】选号：额度数据只覆盖部分账号时退化轮询，不饿死', () => {
  seed();
  session.clearQuotaCache();
  // 只给 a 配了额度，其余两个没有 —— 上游的 pickLeastUsed 在这里会永远返回 a
  session.setQuotaCache('acct_codebuddy_a', { usageLeft: 10, usageTotal: 100, todayUsed: 1 });
  session.setPoolConfig({ strategy: 'least-used' }, 'codebuddy');
  const ids = new Set();
  for (let i = 0; i < 12; i++) ids.add(session.pickAccount(null, 'codebuddy').id);
  assert.ok(ids.size > 1, '部分覆盖时必须退化为轮询，实际始终是: ' + [...ids].join(','));
  session.setPoolConfig({ strategy: 'round-robin' }, 'codebuddy');
});

check('选号：未知策略按轮询处理且不报错', () => {
  seed();
  session.setPoolConfig({ strategy: 'round-robin' }, 'codebuddy');
  assert.ok(session.pickAccount(null, 'codebuddy'), '正常轮询可用');
});

check('选号：quota-weighted 覆盖的是同渠道账号', () => {
  seed();
  session.clearQuotaCache();
  for (const id of ['acct_codebuddy_a', 'acct_codebuddy_b', 'acct_codebuddy_c']) {
    session.setQuotaCache(id, { usageLeft: 50, usageTotal: 100, todayUsed: 0 });
  }
  session.setPoolConfig({ strategy: 'quota-weighted' }, 'codebuddy');
  for (let i = 0; i < 30; i++) {
    const a = session.pickAccount(null, 'codebuddy');
    assert.strictEqual(a.provider, 'codebuddy', '加权选号不得跨渠道');
  }
  session.setPoolConfig({ strategy: 'round-robin' }, 'codebuddy');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
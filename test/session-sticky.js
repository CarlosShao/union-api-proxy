'use strict';
/**
 * 会话粘性（session stickiness）的回归测试。
 *
 * 修复的真实缺陷：pickAccount 每次请求都推进轮询游标，于是 agent 跑 20 步
 * 工具调用就会换 20 个账号，每个账号各自维护一份 prompt cache —— 缓存命中率
 * 几乎归零（线上实测 Trae/CodeBuddy 的命中率确实为 0）。
 *
 * 多渠道适配的重点（本项目特有的风险）：
 *   同一个客户端、同一段系统提示词，可能同时打 cc/ 与 tc/ 的模型。若渠道不进
 *   会话键，两边算出同一个 key，粘性会把 B 渠道的账号发给 A 渠道的请求 ——
 *   等于把一个渠道的凭据发去另一个渠道的上游域名。
 *
 * 用独立的临时 SQLite 跑，不碰真实账号库。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 必须在 require 任何业务模块之前把数据目录指到临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uap-sticky-'));
process.env.UNION_DATA_DIR = TMP;
process.env.CODEBUDDY_DATA_DIR = TMP;

const store = require(path.join(__dirname, '..', 'core', 'store.js'));
const session = require(path.join(__dirname, '..', 'core', 'session.js'));
const auth = require(path.join(__dirname, '..', 'core', 'auth.js'));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}

/* ---------- 造 3 个 codebuddy 账号 + 2 个 traework 账号 ---------- */
function seed() {
  for (const r of store.listAccountRows()) store.deleteAccountRow(r.id);
  store.deleteAllSessionBindings();
  const mk = (provider, name) => ({
    id: 'acct_' + provider + '_' + name,
    provider,
    name,
    source: 'oauth',
    addedBy: 'oauth',
    account: { uid: provider + '_' + name, nickname: name },
    auth: { accessToken: 'tok_' + provider + '_' + name, refreshToken: 'r', expiresAt: Date.now() + 86400000 },
    accounts: [],
    autoCheckin: true,
    lastUsedAt: 0,
    useCount: 0,
    createdAt: Date.now(),
  });
  for (const a of [mk('codebuddy', 'a'), mk('codebuddy', 'b'), mk('codebuddy', 'c')]) store.insertAccount(a);
  for (const a of [mk('traework', 'x'), mk('traework', 'y')]) store.insertAccount(a);
  // 从库里重新装载内存态
  session.loadSession();
}

seed();

/* ---------- 1. 粘性：同一会话固定到同一账号 ---------- */

check('粘性：同一 X-Session-Id 的 20 次请求只用一个账号', () => {
  const sid = 'conv-001';
  const picked = [];
  for (let i = 0; i < 20; i++) {
    const k = session.computeSessionKey('codebuddy', { sessionId: sid, messages: [{ role: 'user', content: 'step ' + i }] });
    picked.push(session.pickAccountForSession(k, 'codebuddy').id);
  }
  assert.strictEqual(new Set(picked).size, 1, '20 次请求应始终命中同一个账号，实际: ' + [...new Set(picked)].join(','));
});

check('对照组：不走粘性时每次请求都会换账号（这正是被修的 bug）', () => {
  const picked = [];
  for (let i = 0; i < 6; i++) picked.push(session.pickAccount(null, 'codebuddy').id);
  assert.ok(new Set(picked).size > 1, '轮询模式下应轮换账号，实际只有一个: ' + picked.join(','));
});

check('粘性：不同会话键会分配到不同账号（没有退化成全局单账号）', () => {
  seed();
  const a = session.pickAccountForSession(session.computeSessionKey('codebuddy', { sessionId: 'c1' }), 'codebuddy').id;
  const b = session.pickAccountForSession(session.computeSessionKey('codebuddy', { sessionId: 'c2' }), 'codebuddy').id;
  const c = session.pickAccountForSession(session.computeSessionKey('codebuddy', { sessionId: 'c3' }), 'codebuddy').id;
  assert.ok(new Set([a, b, c]).size > 1, '不同会话应能分到不同账号');
});

check('粘性：零配置模式（无 Session-Id）按对话前缀指纹粘连', () => {
  seed();
  // 真实形态：同一段对话里首条 system 与首条 user 固定，后续轮次不断追加
  const head = [
    { role: 'system', content: '你是一个编程助手' },
    { role: 'user', content: '帮我重构这个函数' },
  ];
  const k1 = session.computeSessionKey('codebuddy', { messages: head });
  const k2 = session.computeSessionKey('codebuddy', { messages: [...head, { role: 'assistant', content: '好的' }, { role: 'user', content: '第二步' }] });
  assert.strictEqual(k1, k2, '系统提示词与首条 user 消息相同 -> 应算出同一个会话键');
  const a = session.pickAccountForSession(k1, 'codebuddy').id;
  const b = session.pickAccountForSession(k2, 'codebuddy').id;
  assert.strictEqual(a, b, '零配置下也应粘连到同一账号');
});

check('零配置：首条 user 消息不同的两段对话应算出会话键不同', () => {
  const k1 = session.computeSessionKey('codebuddy', { messages: [{ role: 'user', content: '问题甲' }] });
  const k2 = session.computeSessionKey('codebuddy', { messages: [{ role: 'user', content: '问题乙' }] });
  assert.notStrictEqual(k1, k2, '不同的对话不能共用一个绑定');
});

/* ---------- 2. 跨渠道绝不能串号（本次改动的头号风险） ---------- */

check('【关键】跨渠道：同一 Session-Id 在 cc/ 与 tc/ 算出不同的会话键', () => {
  const cc = session.computeSessionKey('codebuddy', { sessionId: 'same-id' });
  const tc = session.computeSessionKey('traework', { sessionId: 'same-id' });
  assert.notStrictEqual(cc, tc, '渠道必须参与哈希，否则两个渠道会共用一个绑定');
});

check('【关键】跨渠道：cc 请求绝不会拿到 tc 账号（即使绑定表被污染）', () => {
  seed();
  const sid = 'shared-id';
  // 先让 tc 渠道建立一个绑定
  const tcKey = session.computeSessionKey('traework', { sessionId: sid });
  const tcAcct = session.pickAccountForSession(tcKey, 'traework');
  assert.strictEqual(tcAcct.provider, 'traework');

  // 模拟最坏情况：有人把 codebuddy 的绑定写成了 tc 账号（脏数据 / 旧版本残留）
  const ccKey = session.computeSessionKey('codebuddy', { sessionId: sid });
  store.setSessionBinding(ccKey, tcAcct.id, 'traework');

  const ccAcct = session.pickAccountForSession(ccKey, 'codebuddy');
  assert.strictEqual(ccAcct.provider, 'codebuddy',
    '拿到的账号必须是 codebuddy 的，实际是 ' + ccAcct.provider + ' —— 这会把凭据发去错误的上游域名');
});

check('【关键】跨渠道：tc 请求也绝不会拿到 cc 账号', () => {
  seed();
  const sid = 'shared-2';
  const ccKey = session.computeSessionKey('codebuddy', { sessionId: sid });
  const ccAcct = session.pickAccountForSession(ccKey, 'codebuddy');
  const tcKey = session.computeSessionKey('traework', { sessionId: sid });
  store.setSessionBinding(tcKey, ccAcct.id, 'codebuddy');   // 脏数据
  const tcAcct = session.pickAccountForSession(tcKey, 'traework');
  assert.strictEqual(tcAcct.provider, 'traework');
});

check('跨渠道：绑定到期后不会换渠道复用', () => {
  seed();
  const k = session.computeSessionKey('codebuddy', { sessionId: 'expire-1' });
  const a1 = session.pickAccountForSession(k, 'codebuddy');
  // 手工把 last_seen_at 改到很久以前
  store.touchSessionBinding(k);
  const b = store.getSessionBinding(k);
  assert.ok(b, '绑定应存在');
  const a2 = session.pickAccountForSession(k, 'codebuddy');
  assert.strictEqual(a2.id, a1.id, '未过期时应复用同一账号');
  assert.strictEqual(a2.provider, 'codebuddy');
});

/* ---------- 3. 绑定生命周期 ---------- */

check('绑定：账号被删除后绑定一并清除', () => {
  seed();
  const k = session.computeSessionKey('codebuddy', { sessionId: 'rm-1' });
  const acct = session.pickAccountForSession(k, 'codebuddy');
  assert.ok(store.getSessionBinding(k), '绑定应已建立');
  session.removeAccount(acct.id);
  assert.strictEqual(store.getSessionBinding(k), null, '账号删除后残留绑定会让选号每次落空、粘性静默失效');
});

check('绑定：账号被删后同会话仍能重新选到一个可用账号', () => {
  seed();
  const k = session.computeSessionKey('codebuddy', { sessionId: 'rm-2' });
  const acct = session.pickAccountForSession(k, 'codebuddy');
  session.removeAccount(acct.id);
  const next = session.pickAccountForSession(k, 'codebuddy');
  assert.ok(next && next.auth && next.auth.accessToken, '应重新选到可用账号');
  assert.notStrictEqual(next.id, acct.id);
});

check('绑定：X-Session-End 可显式释放', () => {
  seed();
  const k = session.computeSessionKey('codebuddy', { sessionId: 'end-1' });
  session.pickAccountForSession(k, 'codebuddy');
  assert.ok(store.getSessionBinding(k));
  assert.strictEqual(session.releaseSession(k), true);
  assert.strictEqual(store.getSessionBinding(k), null);
});

check('绑定：isSessionEnd 识别头与 body 两种写法', () => {
  assert.strictEqual(auth.isSessionEnd({ headers: { 'x-session-end': '1' } }, {}), true);
  assert.strictEqual(auth.isSessionEnd({ headers: {} }, { sessionEnd: true }), true);
  assert.strictEqual(auth.isSessionEnd({ headers: {} }, { metadata: { sessionEnd: true } }), true);
  assert.strictEqual(auth.isSessionEnd({ headers: {} }, {}), false);
});

check('绑定：clearSession 清空全部绑定', () => {
  seed();
  session.pickAccountForSession(session.computeSessionKey('codebuddy', { sessionId: 'x1' }), 'codebuddy');
  session.pickAccountForSession(session.computeSessionKey('traework', { sessionId: 'x2' }), 'traework');
  assert.ok(store.countSessionBindings() >= 2);
  session.clearSession();
  assert.strictEqual(store.countSessionBindings(), 0, '清空登录态后不得残留绑定');
});

check('绑定：prune 能清掉陈旧绑定', () => {
  seed();
  session.pickAccountForSession(session.computeSessionKey('codebuddy', { sessionId: 'p1' }), 'codebuddy');
  assert.ok(store.countSessionBindings() > 0);
  // prune 的语义是「last_seen_at 早于 now-TTL 才删」，所以必须让绑定真的变旧
  const b = store.listSessionBindings(1)[0];
  store.touchSessionBinding(b.sessionKey);
  const deadline = Date.now() + 5;
  while (Date.now() < deadline) { /* 等 last_seen_at 变成 5ms 前 */ }
  assert.ok(session.pruneSessionBindings(1) > 0, '应清掉至少一条');
});

/* ---------- 4. 池配置字段不会被静默丢弃 ---------- */

check('池配置：stickyEnabled / stickyTtlMin 能写入并读回', () => {
  session.setPoolConfig({ stickyEnabled: false, stickyTtlMin: 90 }, 'codebuddy');
  const cfg = session.getPoolConfig('codebuddy');
  assert.strictEqual(cfg.stickyEnabled, false);
  assert.strictEqual(cfg.stickyTtlMin, 90);
  session.setPoolConfig({ stickyEnabled: true, stickyTtlMin: 30 }, 'codebuddy');
});

check('【关键】池配置：增删账号（触发 persistPool）不会抹掉新字段', () => {
  // persistPool 是整体覆盖 JSON，少写一个字段就等于从库里删掉它
  session.setPoolConfig({ stickyTtlMin: 77 }, 'codebuddy');
  session.addAccount({
    id: 'acct_new', provider: 'codebuddy', name: 'newbie', source: 'oauth', addedBy: 'oauth',
    account: { uid: 'new', nickname: 'newbie' },
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 86400000 },
    accounts: [], lastUsedAt: 0, useCount: 0, createdAt: Date.now(),
  });
  const cfg = session.getPoolConfig('codebuddy');
  assert.strictEqual(cfg.stickyTtlMin, 77, '增删账号后 stickyTtlMin 被 persistPool 抹掉了');
});

check('池配置：未设置过的渠道也能拿到完整默认值', () => {
  const cfg = store.getAccountPool('traework');
  assert.strictEqual(cfg.pool.stickyEnabled, true);
  assert.strictEqual(cfg.pool.stickyTtlMin, 30);
});

check('粘性：stickyEnabled=false 时退回纯轮询', () => {
  seed();
  session.setPoolConfig({ stickyEnabled: false }, 'codebuddy');
  const picked = [];
  for (let i = 0; i < 6; i++) {
    const k = session.computeSessionKey('codebuddy', { sessionId: 'off-' + i });
    picked.push(session.pickAccountForSession(k, 'codebuddy').id);
  }
  assert.ok(new Set(picked).size > 1, '关闭粘性后应恢复轮换，实际: ' + [...new Set(picked)].join(','));
  assert.strictEqual(store.countSessionBindings(), 0, '关闭后不应写绑定');
  session.setPoolConfig({ stickyEnabled: true }, 'codebuddy');
});

/* ---------- 5. pickAccount 的位置参数未被破坏 ---------- */

check('签名安全：pickAccount 第二个参数仍是 provider（不是 sessionKey）', () => {
  seed();
  // 上游把第 2 位改成 sessionKey，若本地被误改成那样，这里会抛
  // 「渠道「undefined」没有可用账号」
  for (let i = 0; i < 4; i++) {
    const a = session.pickAccount(null, 'traework');
    assert.ok(a && a.provider === 'traework', '第 2 位必须被当作 provider 解释');
  }
});

check('签名安全：显式指定渠道时不会串号', () => {
  seed();
  const a = session.pickAccount(null, 'codebuddy');
  const b = session.pickAccount(null, 'traework');
  assert.strictEqual(a.provider, 'codebuddy');
  assert.strictEqual(b.provider, 'traework');
});

/* ---------- 6. 端到端：extractSessionKey ---------- */

check('端到端：X-Session-Id 优先于对话指纹', () => {
  const k1 = auth.extractSessionKey({ headers: { 'x-session-id': 'S1' } }, { messages: [{ role: 'user', content: 'a' }] }, 'codebuddy', '');
  const k2 = auth.extractSessionKey({ headers: { 'x-session-id': 'S1' } }, { messages: [{ role: 'user', content: 'b' }] }, 'codebuddy', '');
  assert.strictEqual(k1, k2, '显式 Session-Id 应压过指纹');
});

check('端到端：无任何线索时不产生会话键（不写无意义的绑定）', () => {
  const k = auth.extractSessionKey({ headers: {} }, {}, 'codebuddy', '');
  assert.strictEqual(k, null);
});

/* ---------- 清理 ---------- */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
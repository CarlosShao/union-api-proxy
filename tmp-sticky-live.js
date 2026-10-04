const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const db = new DatabaseSync('/data/proxy.db', { readOnly: true });
const row = db.prepare('SELECT key FROM api_keys LIMIT 1').get();
db.close();

function post(pathname, body, headers) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: 3800, path: pathname, method: 'POST',
        headers: Object.assign({ Authorization: 'Bearer ' + row.key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers || {}) },
      (res) => {
        let b = ''; res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.write(payload); req.end();
  });
}

function bindings() {
  const d = new DatabaseSync('/data/proxy.db', { readOnly: true });
  const rows = d.prepare('SELECT session_key, account_id, provider, req_count FROM session_bindings').all();
  d.close();
  return rows;
}

(async () => {
  // 同一会话 id 连发 5 次（模拟 agent 工具调用多轮）
  const sid = 'live-test-' + Date.now();
  console.log('=== A) 同一 X-Session-Id 连发 5 次 ===');
  for (let i = 0; i < 5; i++) {
    const r = await post('/v1/chat/completions',
      { model: 'cc/default', messages: [{ role: 'user', content: '第 ' + i + ' 轮' }], stream: false },
      { 'X-Session-Id': sid });
    console.log('  第' + (i + 1) + '次: HTTP ' + r.status);
  }
  let b = bindings().filter((x) => x.session_key);
  console.log('  绑定条数:', b.length, '| 绑定内容:', JSON.stringify(b));
  const one = new Set(b.map((x) => x.account_id)).size;
  console.log('  ' + (b.length === 1 && one === 1 ? '✓ 5 次请求只落到 1 个账号（粘性生效）' : '✗ 期望恰好 1 条绑定'));

  // 跨渠道：同一个 X-Session-Id 打 cc 与 tc
  console.log('\n=== B) 跨渠道串号检查（同一个 X-Session-Id） ===');
  const shared = 'xchan-' + Date.now();
  await post('/v1/chat/completions', { model: 'cc/default', messages: [{ role: 'user', content: 'hi' }], stream: false }, { 'X-Session-Id': shared });
  await post('/v1/chat/completions', { model: 'tc/glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], stream: false }, { 'X-Session-Id': shared });
  const cross = bindings();
  const provs = {};
  for (const x of cross) { provs[x.provider] = (provs[x.provider] || 0) + 1; }
  console.log('  按渠道的绑定分布:', JSON.stringify(provs));
  console.log('  ' + (provs.codebuddy >= 1 && provs.traework >= 1
    ? '✓ cc 与 tc 各自建立了独立绑定，没有共用'
    : '✗ 渠道绑定分布异常'));

  // 校验：cc 的绑定指向的账号必须是 codebuddy 的
  const acctDb = new DatabaseSync('/data/proxy.db', { readOnly: true });
  let mismatch = [];
  for (const x of cross) {
    const a = acctDb.prepare('SELECT provider FROM accounts WHERE id=?').get(x.account_id);
    if (!a || a.provider !== x.provider) mismatch.push(x.session_key + ': ' + x.provider + ' -> ' + (a ? a.provider : '账号不存在'));
  }
  acctDb.close();
  console.log('  ' + (mismatch.length === 0 ? '✓ 每条绑定指向的账号渠道都与绑定渠道一致' : '✗ 存在跨渠道错绑: ' + JSON.stringify(mismatch)));

  // X-Session-End 释放
  console.log('\n=== C) X-Session-End 释放绑定 ===');
  const before = bindings().length;
  await post('/v1/chat/completions', { model: 'cc/default', messages: [{ role: 'user', content: 'hi' }], stream: false },
    { 'X-Session-Id': 'endtest-' + Date.now(), 'X-Session-End': '1' });
  console.log('  ' + (bindings().length <= before ? '✓ 声明会话结束后未新增残留绑定' : '✗ 绑定未被释放'));
})();
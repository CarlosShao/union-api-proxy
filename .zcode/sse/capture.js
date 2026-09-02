'use strict';
// 抓取 SSE 原始流并输出时间线 + 事件序列分析
// 用法: node capture.js <upstream|proxy> <outfile>
const fs = require('fs');
const http = require('http');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');

const mode = process.argv[2];
const outfile = process.argv[3];
const db = new DatabaseSync(process.env.USERPROFILE + '/.codebuddy-proxy/proxy.db');

const payload = {
  model: 'default',
  stream: true,
  messages: [
    { role: 'user', content: '一个农场有鸡和兔共35个头、94只脚，问鸡兔各几只？请先仔细思考再给出答案。另外如果你能查天气，顺便查下北京今天天气。' },
  ],
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询城市当前天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }],
};
// 额外 payload 覆盖（JSON），如 '{"enable_thinking":true}'
if (process.argv[4]) { try { Object.assign(payload, JSON.parse(process.argv[4])); } catch (e) { console.error('payload 参数解析失败:', e.message); } }

const t0 = Date.now();
const timeline = [];
let raw = '';
let status = 0;

function onData(chunk) {
  timeline.push({ t: Date.now() - t0, bytes: chunk.length });
  raw += chunk;
}

let req;
if (mode === 'upstream') {
  const row = db.prepare('SELECT auth, account FROM accounts LIMIT 1').get();
  const auth = JSON.parse(row.auth);
  const account = JSON.parse(row.account);
  const headers = {
    'Authorization': 'Bearer ' + auth.accessToken,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'CodeBuddy-Proxy/1.0',
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  if (account && account.uid) headers['X-User-Id'] = account.uid;
  if (account && account.enterpriseId) { headers['X-Enterprise-Id'] = account.enterpriseId; headers['X-Tenant-Id'] = account.enterpriseId; }
  if (auth.domain) headers['X-Domain'] = auth.domain;
  const body = JSON.stringify(payload);
  headers['Content-Length'] = Buffer.byteLength(body);
  req = https.request('https://copilot.tencent.com/v2/chat/completions', { method: 'POST', headers });
} else {
  const key = db.prepare('SELECT key FROM api_keys LIMIT 1').get().key;
  const body = JSON.stringify(payload);
  req = http.request('http://127.0.0.1:3800/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
}

req.on('response', (res) => {
  status = res.statusCode;
  res.setEncoding('utf8');
  res.on('data', onData);
  res.on('end', finish);
});
req.on('error', (e) => { console.error('请求失败:', e.message); process.exit(1); });
req.setTimeout(120000, () => req.destroy(new Error('timeout')));
req.write(JSON.stringify(payload));
req.end();

function finish() {
  fs.writeFileSync(outfile, raw);
  fs.writeFileSync(outfile + '.timeline.json', JSON.stringify(timeline));

  // 解析事件序列
  const events = [];
  for (const block of raw.split('\n\n')) {
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch { /* 半包由上游保证不出现 */ }
    }
  }
  const seq = [];
  const ids = new Set();
  let reasoningChars = 0, contentChars = 0;
  for (const ev of events) {
    if (ev.id) ids.add(ev.id);
    const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (!d) { seq.push('?'); continue; }
    const r = d.reasoning_content, c = d.content;
    if (typeof r === 'string' && r.length) { seq.push('R'); reasoningChars += r.length; }
    if (typeof c === 'string' && c.length) { seq.push('C'); contentChars += c.length; }
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) seq.push('T');
    if (d.function_call && (d.function_call.name || d.function_call.arguments)) seq.push('F');
    if (!seq.length || seq[seq.length - 1] === '?') { if (!r && !c && !d.tool_calls) seq.push('.'); }
  }
  // 压缩序列 R×120 C×40 ...
  const runs = [];
  for (const s of seq) {
    if (runs.length && runs[runs.length - 1].ch === s) runs[runs.length - 1].n++;
    else runs.push({ ch: s, n: 1 });
  }
  // 交替次数
  let alternations = 0;
  const types = seq.filter((s) => 'RC'.includes(s));
  for (let i = 1; i < types.length; i++) if (types[i] !== types[i - 1]) alternations++;
  // 时间间隙
  const gaps = [];
  for (let i = 1; i < timeline.length; i++) {
    const g = timeline[i].t - timeline[i - 1].t;
    if (g >= 300) gaps.push({ at: timeline[i].t, gap: g });
  }

  const report = {
    mode, status,
    totalChunks: timeline.length,
    totalEvents: events.length,
    distinctChunkIds: ids.size,
    reasoningChars, contentChars,
    reasoningContentRuns: runs.map((r) => r.ch + '×' + r.n).join(' '),
    typeAlternations: alternations,
    firstChunkAt: timeline.length ? timeline[0].t : -1,
    lastChunkAt: timeline.length ? timeline[timeline.length - 1].t : -1,
    gapsOver300ms: gaps,
  };
  console.log(JSON.stringify(report, null, 2));
}

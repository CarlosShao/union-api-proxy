'use strict';
/**
 * 端到端验证用假上游：模拟 CodeBuddy 服务端。
 * 记录代理发出的所有请求头到 fake-upstream-capture.json，并返回可用的刷新/账号/SSE 响应。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9913;
const CAPTURE = path.join(__dirname, 'fake-upstream-capture.json');
const capture = [];

function sseChunks() {
  const mk = (delta, finish) => JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1700000000, model: 'default',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    'data: ' + mk({ role: 'assistant', content: 'he' }) + '\n\n',
    'data: ' + mk({ content: 'llo' }) + '\n\n',
    'data: ' + mk({}, 'stop') + '\n\n',
    'data: ' + JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1700000000, model: 'default', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + '\n\n',
    'data: [DONE]\n\n',
  ].join('');
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    capture.push({ method: req.method, url: req.url, headers: req.headers, bodyLen: body.length });
    fs.writeFileSync(CAPTURE, JSON.stringify(capture, null, 2));
    console.log(`[fake-up] ${req.method} ${req.url}`);

    if (req.url.startsWith('/v2/plugin/auth/token/refresh')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', tokenType: 'Bearer', expiresIn: 86400, domain: '127.0.0.1:' + PORT } }));
    }
    if (req.url.startsWith('/v2/plugin/login/account')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, msg: 'ok', data: { uid: 'test-uid-1', nickname: 'TestUser', type: 'personal' } }));
    }
    if (req.url.startsWith('/v2/plugin/accounts')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, msg: 'ok', data: [] }));
    }
    if (req.url.startsWith('/v2/chat/completions')) {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (payload.stream === false) {
        // 非流式也回 SSE（真实上游行为），由代理聚合成 completion
        return res.end(sseChunks());
      }
      return res.end(sseChunks());
    }
    // WorkBuddy 签到/积分等端点：一律 404 JSON，避免调度器报错
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -1, msg: 'not implemented in fake upstream' }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake upstream on http://127.0.0.1:${PORT}`));

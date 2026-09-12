'use strict';

/** 通用工具：HTTP 请求封装、响应发送、字符串工具等 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// 上游连接复用：keep-alive 池化，避免每轮工具调用（尤其长思考空隙后）重新 TCP+TLS 握手
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 });

function agentFor(protocol) { return protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT; }

/** JSON 请求，返回 { status, headers, body, json } */
function requestJson(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload != null && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    if (payload != null) finalHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = mod.request(u, { method, headers: finalHeaders, timeout: timeoutMs, agent: agentFor(u.protocol) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, body: text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** 原始请求，返回 { status, headers, body } 字符串（用于收集 SSE 流） */
function requestRaw(urlStr, { method = 'POST', headers = {}, body = null, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload != null && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    if (payload != null) finalHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = mod.request(u, { method, headers: finalHeaders, timeout: timeoutMs, agent: agentFor(u.protocol) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** 把上游响应透传给客户端（用于 SSE 流式转发） */
function pipeToClient(clientRes, urlStr, { method = 'POST', headers = {}, body = null, extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload != null && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    if (payload != null) finalHeaders['Content-Length'] = Buffer.byteLength(payload);

    const upstream = mod.request(u, { method, headers: finalHeaders, agent: agentFor(u.protocol) }, (upRes) => {
      const respHeaders = { ...(upRes.headers || {}), ...extraHeaders };
      clientRes.writeHead(upRes.statusCode || 502, respHeaders);
      upRes.pipe(clientRes);
      upRes.on('end', resolve);
      upRes.on('error', reject);
    });
    upstream.on('error', (e) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } }));
      }
      reject(e);
    });
    if (payload != null) upstream.write(payload);
    upstream.end();
  });
}

/**
 * 规范化上游 SSE 事件块。
 * CodeBuddy 上游的 delta 是"全字段"格式：思考阶段的 chunk 也带 content:""，
 * 正文阶段也带 reasoning_content:""（另有恒空的 refusal:"" / tool_calls:[]）。
 * ZCode 的 openai-compatible 转换层（ai-sdk）会因此把每个思考 delta 切成独立的
 * reasoning 块——UI 表现为一条回复出现几十上百个"思考·持续了几秒"。
 * 这里把空字符串/空数组字段剥掉，使 delta 只携带有效字段（标准 OpenAI 形态）。
 * 无需修改的事件按原文返回，零重写成本。
 */
function normalizeSseBlock(block) {
  const lines = block.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return line;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return line;
    let obj;
    try { obj = JSON.parse(data); } catch { return line; }
    const choice = obj && obj.choices && obj.choices[0];
    const delta = choice && choice.delta;
    if (!delta || typeof delta !== 'object') return line;
    let touched = false;
    for (const k of ['content', 'reasoning_content', 'refusal']) {
      if (delta[k] === '') { delete delta[k]; touched = true; }
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) { delete delta.tool_calls; touched = true; }
    if (delta.function_call === null) { delete delta.function_call; touched = true; }
    return touched ? 'data: ' + JSON.stringify(obj) : line;
  });
  return lines.join('\n');
}

/**
 * 把上游 SSE 流转发到客户端，同时解析其中的 token 用量。
 * onDone({ usage, status }) 在流结束时回调。usage 为 OpenAI chat.completion.chunk 里的 usage 对象。
 * 兼容 `stream_options.include_usage` 的最后一块，也兼容流结束后单独追加的 usage 块。
 *
 * converter：可选的渠道专属「上游流 -> OpenAI SSE」转换器（如 Trae 的 SOLO 事件流）。
 *   提供时，上游字节先喂给 feed()，其输出再经 normalizeSseBlock 收尾后下发；
 *   不提供时走默认路径（上游本身已是 OpenAI SSE，只做空字段剥离）。
 *   两种路径最终都经过 normalizeSseBlock —— 这是防止 AI SDK 把思考 delta
 *   切成大量碎片（UI 表现为反复「思考了几秒」）的关键，对所有渠道一视同仁。
 */
function pipeSseToClient(clientRes, urlStr, { method = 'POST', headers = {}, body = null, extraHeaders = {}, converter = null }, onDone) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload != null && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    if (payload != null) finalHeaders['Content-Length'] = Buffer.byteLength(payload);

    let usage = null;
    let status = 'ok';
    const report = () => { if (onDone) try { onDone({ usage, status }); } catch { /* ignore */ } };

    // CODEBUDDY_DEBUG 下记录 chunk 间隙：用于定位事件循环停顿 / 上游断流造成的秒级思考分段
    const debugGaps = !!process.env.CODEBUDDY_DEBUG;
    const startedAt = Date.now();
    let lastChunkAt = startedAt;
    let firstChunk = true;

    /** 从一段 OpenAI SSE 文本里提取 usage（两种路径共用） */
    const extractUsage = (text) => {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const obj = JSON.parse(data);
          if (obj && obj.usage) usage = obj.usage;
        } catch { /* skip */ }
      }
    };

    const upstream = mod.request(u, { method, headers: finalHeaders, agent: agentFor(u.protocol) }, (upRes) => {
      const respHeaders = { ...(upRes.headers || {}), ...extraHeaders };
      clientRes.writeHead(upRes.statusCode || 502, respHeaders);
      const upstreamOk = upRes.statusCode >= 200 && upRes.statusCode < 300;
      if (!upstreamOk) status = 'error';

      // 上游报错：原始体直接透传，不能喂给转换器（会把错误文本转成空回复）
      if (!upstreamOk) {
        upRes.pipe(clientRes);
        upRes.on('end', () => { report(); resolve(); });
        upRes.on('error', (e) => { report(); reject(e); });
        return;
      }

      // 转换器模式下上游是自定义事件流，按 \n\n 切块无意义，必须整段喂给 converter
      if (converter) {
        let pending = '';
        const emit = (text) => {
          if (!text) return;
          const normalized = normalizeSseBlock(text.replace(/\n+$/, ''));
          extractUsage(normalized);
          clientRes.write(normalized + '\n\n');
          pending = '';
        };
        upRes.setEncoding('utf8');
        upRes.on('data', (chunk) => {
          const now = Date.now();
          if (debugGaps) {
            const gap = now - lastChunkAt;
            if (firstChunk) console.log(`[sse-debug] 首字节 TTFB ${gap}ms`);
            else if (gap >= 500) console.log(`[sse-debug] chunk 间隙 ${gap}ms（事件循环停顿或上游断流）`);
          }
          lastChunkAt = now;
          firstChunk = false;
          try { pending += converter.feed(chunk); } catch { /* 转换异常不中断流 */ }
          if (pending) emit(pending);
        });
        upRes.on('end', () => {
          try { pending += converter.end(); } catch { /* ignore */ }
          emit(pending);
          // 转换器可能把 usage 保留在内部状态（如 token_usage 事件先于末块到达）
          if (!usage && typeof converter.getUsage === 'function') {
            try { usage = converter.getUsage(); } catch { /* ignore */ }
          }
          clientRes.end();
          report();
          resolve();
        });
        upRes.on('error', (e) => { status = 'error'; report(); reject(e); });
        return;
      }

      let buf = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (chunk) => {
        const now = Date.now();
        if (debugGaps) {
          const gap = now - lastChunkAt;
          if (firstChunk) console.log(`[sse-debug] 首字节 TTFB ${gap}ms`);
          else if (gap >= 500) console.log(`[sse-debug] chunk 间隙 ${gap}ms（事件循环停顿或上游断流）`);
        }
        lastChunkAt = now;
        firstChunk = false;
        buf += chunk;
        let idx;
        let out = '';
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          out += normalizeSseBlock(block) + '\n\n';
          extractUsage(block);
        }
        if (out) clientRes.write(out);
      });
      upRes.on('end', () => {
        if (buf.trim()) {
          clientRes.write(normalizeSseBlock(buf) + '\n\n');
          extractUsage(buf);
        }
        clientRes.end();
        report();
        resolve();
      });
      upRes.on('error', (e) => { status = 'error'; report(); reject(e); });
    });
    upstream.on('error', (e) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } }));
      }
      status = 'error';
      report();
      reject(e);
    });
    if (payload != null) upstream.write(payload);
    upstream.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function corsHeaders() {
  let origin = '*';
  try { origin = require('./store').getCorsOrigin() || '*'; } catch { /* store 尚未就绪 */ }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...corsHeaders(),
  });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() });
  res.end(html);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** 以正确的 MIME 流式返回一个静态文件 */
function sendFile(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      sendJson(res, 404, { error: { message: 'Not Found' } });
      return;
    }
    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      ...corsHeaders(),
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function maskedToken(tok) {
  if (!tok) return '';
  if (tok.length <= 8) return '***';
  return `${tok.slice(0, 6)}…${tok.slice(-4)}`;
}

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

module.exports = {
  requestJson, requestRaw, pipeToClient, pipeSseToClient, readBody,
  sendJson, sendHtml, sendFile, MIME_TYPES, corsHeaders,
  escapeHtml, maskedToken, genId, agentFor,
};

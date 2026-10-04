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
function pipeSseToClient(clientRes, urlStr, { method = 'POST', headers = {}, body = null, extraHeaders = {}, converter = null, errorFallback = null }, onDone) {
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
      const upstreamOk = upRes.statusCode >= 200 && upRes.statusCode < 300;

      // 上游报错：原始体直接透传，不能喂给转换器（会把错误文本转成空回复）。
      // 但若上游给的是**空错误体**，客户端（如 DSH）拿不到任何错误信息，
      // 既无法诊断、也无法把它归类成「上下文溢出」去触发压缩重试——这时合成一个。
      if (!upstreamOk) {
        status = 'error';
        const errChunks = [];
        upRes.on('data', (c) => errChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        upRes.on('error', (e) => { report(); reject(e); });
        upRes.on('end', () => {
          const raw = Buffer.concat(errChunks);
          const headers = { ...(upRes.headers || {}), ...extraHeaders };
          if (raw.toString('utf8').trim()) {
            clientRes.writeHead(upRes.statusCode || 502, headers);
            clientRes.end(raw);
          } else {
            // 上游常带 Content-Length: 0 或 Transfer-Encoding: chunked，
            // 两者都与"我自己给出完整长度的合成体"冲突，必须先删掉
            delete headers['content-length'];
            delete headers['Content-Length'];
            delete headers['transfer-encoding'];
            delete headers['Transfer-Encoding'];
            const synthesized = synthesizeUpstreamError(upRes.statusCode, errorFallback);
            headers['Content-Type'] = 'application/json; charset=utf-8';
            headers['Content-Length'] = Buffer.byteLength(synthesized);
            clientRes.writeHead(upRes.statusCode || 502, headers);
            clientRes.end(synthesized);
          }
          report();
          resolve();
        });
        return;
      }

      const respHeaders = { ...(upRes.headers || {}), ...extraHeaders };
      clientRes.writeHead(upRes.statusCode || 502, respHeaders);

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

/**
 * 把客户端传来的「思考强度」归一化成上游唯一认识的 `reasoning_effort` 字符串。
 *
 * CodeBuddy 上游（Go）把该字段声明为 string：
 *   - 传 bool / number / 对象 / 数组 → 400 11101 "cannot unmarshal ... into Go struct
 *     field Request.reasoning_effort of type string"
 *   - 完全不传、传 null 或传空串  → 200，但**不会返回 reasoning_content**（思考默认关闭）
 *   - 传任意非空字符串（官方插件用 low/medium/high）→ 200 且正常返回 reasoning_content
 *
 * 官方插件（tencent-cloud.coding-copilot）的做法是：先由模型配置的
 * reasoning.supportedEfforts / effort / defaultEffort 解析出 effort，再写进
 * providerOptions，最终作为 `reasoning_effort` 发出；解析不出 effort 时**整个字段不发**。
 *
 * 这里兼容各家客户端的不同传法：
 *   reasoning_effort: "high" | reasoning: {effort:"high"} | reasoning_effort: 1..5
 * 并丢弃非字符串/空值，避免把 bool 之类的值透传上去撞 400。
 *
 * @param {object} payload 客户端原始请求体
 * @returns {string|undefined} 归一化后的 effort；无法解析时返回 undefined
 */
function normalizeReasoningEffort(payload) {
  if (!payload || typeof payload !== 'object') return undefined;

  // 数字档位（部分客户端用 1-5 表示强度）映射到上游认的字符串
  const LEVELS = { 1: 'minimal', 2: 'low', 3: 'medium', 4: 'high', 5: 'high' };
  const fromNumber = (n) => (Number.isFinite(n) ? LEVELS[Math.round(n)] : undefined);

  const candidates = [
    payload.reasoning_effort,
    payload.reasoningEffort,
    payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning.effort : payload.reasoning,
    payload.thinking && typeof payload.thinking === 'object' ? payload.thinking.effort : undefined,
  ];

  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) {
      const v = raw.trim();
      // 上游对 "none"/"off" 等并非真的关闭思考（实测仍会返回 reasoning_content），
      // 统一按「关闭」处理，由调用方解析成 undefined。
      if (['none', 'off', 'disabled', 'false'].includes(v.toLowerCase())) continue;
      return v;
    }
    if (typeof raw === 'number') {
      const mapped = fromNumber(raw);
      if (mapped) return mapped;
    }
  }
  return undefined;
}

/**
 * 客户端是否**显式**表达了「思考开关」（无论开还是关）。
 *
 * 用于区分两种「解析不出 effort」：
 *   - 客户端压根没提 reasoning/thinking → 应回落到配置的默认档位；
 *   - 客户端显式传了 "" / null / false / {type:"disabled"} → 用户想关掉思考，
 *     不应再套用默认档位，否则关不掉。
 */
function hasExplicitReasoningIntent(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if ('reasoning_effort' in payload || 'reasoningEffort' in payload) return true;
  if ('reasoning' in payload && payload.reasoning != null) return true;
  if ('thinking' in payload && payload.thinking != null) return true;
  if ('enableThinking' in payload && payload.enableThinking != null) return true;
  return false;
}

/**
 * 客户端是否显式要求「关闭思考」。
 * 覆盖 reasoning_effort:""|"none"|"off"、"reasoning":null|false、
 * thinking:{type:"disabled"} 等常见写法。
 */
function isReasoningDisabled(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const vals = [payload.reasoning_effort, payload.reasoningEffort, payload.reasoning, payload.thinking, payload.enableThinking];
  for (const v of vals) {
    if (v === false || v === null) return true;
    if (typeof v === 'string' && ['', 'none', 'off', 'disabled', 'false'].includes(v.trim().toLowerCase())) return true;
    if (v && typeof v === 'object') {
      if (v.enabled === false || v.disabled === true) return true;
      if (typeof v.type === 'string' && ['disabled', 'none', 'off'].includes(v.type.trim().toLowerCase())) return true;
      if (v.effort != null && typeof v.effort === 'string' && ['', 'none', 'off', 'disabled'].includes(v.effort.trim().toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * 客户端是否显式要求「打开思考」但没给出具体档位。
 * 例如 reasoning_effort:true、thinking:{type:"enabled"}、reasoning:{enabled:true}。
 * 这类请求意图明确为「开」，应套用默认档位，而不是被当成解析失败而丢掉。
 */
function isReasoningEnabled(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const vals = [payload.reasoning_effort, payload.reasoningEffort, payload.reasoning, payload.thinking, payload.enableThinking];
  for (const v of vals) {
    if (v === true) return true;
    if (v && typeof v === 'object') {
      if (v.enabled === true || v.disabled === false) return true;
      if (typeof v.type === 'string' && ['enabled', 'auto', 'on', 'true'].includes(v.type.trim().toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * 清理 payload 中的思考字段并解析出最终要发给上游的 effort。
 *
 * 规则（与官方插件一致：解析不出 effort 就不发该字段）：
 *   1. 客户端显式要求关闭 → 不发 reasoning_effort（思考关闭）
 *   2. 客户端给了可解析的强度 → 用客户端的值
 *   3. 客户端没提这件事 → 用 defaultEffort（为空则不发，保持上游默认行为）
 *
 * @param {object} payload 待清洗的请求体（就地修改）
 * @param {string} [defaultEffort] 未指定时使用的默认强度
 * @returns {string|undefined} 实际写入的 effort
 */
function resolveReasoningEffort(payload, defaultEffort) {
  const explicit = normalizeReasoningEffort(payload);
  const disabled = isReasoningDisabled(payload);
  const enabled = isReasoningEnabled(payload);
  const mentioned = hasExplicitReasoningIntent(payload);

  // 注意：以下 delete 会清掉原始字段，所以上面几个判断必须在删除之前完成。
  // 清掉所有会被上游拒绝的别名/原字段（bool、对象等）
  delete payload.reasoning;
  delete payload.reasoningEffort;
  delete payload.thinking;
  delete payload.enableThinking;
  delete payload.reasoning_effort;

  let effort;
  if (explicit) effort = explicit;                 // 客户端显式强度优先
  else if (disabled) effort = undefined;           // 显式关思考 → 不发该字段
  else if (enabled || !mentioned) {
    // 显式「开」但没给档位，或压根没提 → 用默认档位
    effort = normalizeReasoningEffort({ reasoning: { effort: defaultEffort } });
  } else {
    effort = undefined;                            // 提了但无法解析（如只给 max_tokens）→ 不发
  }

  if (effort) payload.reasoning_effort = effort;
  return effort;
}

/**
 * 把 OpenAI 的 `developer` 角色就地改写成 `system`。
 *
 * 上游 CodeBuddy **不认 `developer` 角色**：
 *   - `role: "system"`    → 200
 *   - `role: "developer"` → 400 11128 "Illegal API invocation from an unapproved channel"
 *
 * 这个坑很容易踩到，因为下游客户端会在「模型支持思考」时自动把系统提示词
 * 发成 `developer`（DSH 的判断是 `model.reasoning && compat.supportsDeveloperRole`，
 * 而该 compat 对自定义 baseURL 网关默认为 true）。
 *
 * `developer` 与 `system` 在 OpenAI 语义里是同一角色的新旧名字，改写不丢信息：
 * 顺序与内容都原样保留，只换角色名。
 *
 * 注意：CodeBuddy 渠道实际使用 providers/codebuddy/index.js 的 preparePayload，
 * 它在此基础上还会合并多条 system 消息；本函数是与之等价的通用实现。
 *
 * @param {object} payload 待清洗的请求体（就地修改）
 * @returns {number} 被改写的消息条数（0 表示无需改写）
 */
function normalizeDeveloperRole(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  if (!Array.isArray(payload.messages)) return 0;

  let changed = 0;
  for (const msg of payload.messages) {
    if (msg && typeof msg === 'object' && msg.role === 'developer') {
      msg.role = 'system';
      changed++;
    }
  }
  return changed;
}

/**
 * 上游返回错误、但响应体为空时，合成一个 JSON 错误体。
 *
 * 为什么需要：某些上游（实测腾讯 CodeBuddy）报错时只给状态码、不给 body。
 * 客户端拿到 `400 (no body)` 后既无法诊断，也无法把错误归类为「上下文溢出」，
 * 于是不会触发它自己的「压缩后重试」恢复路径，只能把原始错误甩给用户。
 *
 * fallback.overflow 为真时，文案带上客户端能识别的溢出特征
 * （DSH 的正则认得 `maximum context length` 这种写法）。
 *
 * @param {number} status 上游 HTTP 状态码
 * @param {{ overflow?: boolean, detail?: string }} [fallback] 代理侧的判断与补充说明
 * @returns {string} JSON 字符串
 */
function synthesizeUpstreamError(status, fallback) {
  const f = fallback || {};
  const suffix = f.detail ? ` (${f.detail})` : '';
  if (f.overflow) {
    return JSON.stringify({
      error: {
        message: `maximum context length exceeded: upstream rejected the request with HTTP ${status} and no body${suffix}`,
        type: 'context_length_exceeded',
        code: status,
      },
    });
  }
  return JSON.stringify({
    error: {
      message: `upstream rejected the request with HTTP ${status} and an empty body${suffix}`,
      type: 'proxy_upstream_error',
      code: status,
    },
  });
}

/**
 * 从各家上游的 usage 里取「缓存命中的 prompt token 数」。
 *
 * 没有单一标准，必须都认：
 *   - OpenAI chat:  usage.prompt_cache_hit_tokens / usage.prompt_tokens_details.cached_tokens
 *   - OpenAI resp:   usage.input_tokens_details.cached_tokens
 *   - Anthropic 系：usage.cache_read_input_tokens
 *     （Trae SOLO 实测就用这个写法，见 providers/traework/sse.js 的 token_usage 事件）
 *
 * 此前只认前两种，导致 Trae 的缓存命中恒被记成 0 —— 上游就算真的命中了也看不到。
 *
 * 注意：Trae 还带一组 `*_total` 后缀字段（cache_read_input_tokens_total 等），
 * 那是累计口径 —— 同一响应里 total_tokens_total 恒为 0 而 total_tokens 非 0 ——
 * 不能当单次请求的缓存命中，故不参与匹配。
 *
 * @param {object} usage 上游返回的 usage 对象
 * @returns {number} 缓存命中的 prompt token 数（无则 0）
 */
function cachedTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const ptd = usage.prompt_tokens_details;
  const itd = usage.input_tokens_details;
  return n(
    usage.prompt_cache_hit_tokens
    || (ptd && ptd.cached_tokens)
    || (itd && itd.cached_tokens)
    || usage.cache_read_input_tokens
  );
}

module.exports = {
  requestJson, requestRaw, pipeToClient, pipeSseToClient, readBody,
  sendJson, sendHtml, sendFile, MIME_TYPES, corsHeaders,
  escapeHtml, maskedToken, genId, agentFor, synthesizeUpstreamError,
  normalizeReasoningEffort, resolveReasoningEffort,
  hasExplicitReasoningIntent, isReasoningDisabled, isReasoningEnabled,
  normalizeDeveloperRole, cachedTokensOf,
};

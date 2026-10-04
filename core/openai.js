'use strict';

/** OpenAI 兼容转发：/v1/chat/completions、/v1/completions、/v1/embeddings */

const fs = require('fs');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
// 惰性引用 session：session -> store，且 openai 已在 session 之前加载，
// 顶层 require 会拿到半初始化的对象。
const sessionModRelease = (key) => require('./session').releaseSession(key);
const auth = require('./auth');
const providers = require('./providers/all');
const models = require('./models');

const UPSTREAM_MAP = {
  '/v1/chat/completions': '/v2/chat/completions',
  '/v1/completions': '/v2/completions',
  '/v1/embeddings': '/v2/embeddings',
  '/v2/chat/completions': '/v2/chat/completions',
  '/v2/completions': '/v2/completions',
  '/v2/embeddings': '/v2/embeddings',
};

// 仅 CodeBuddy 有这两个端点（Trae SOLO 通道只提供 chat）
const CHAT_PATHS = new Set(['/v1/chat/completions', '/v2/chat/completions']);

/** 把 CodeBuddy 的 SSE 流聚合成一个 OpenAI 非流式 chat.completion 响应 */
function aggregateSseToCompletion(sseText) {
  const chunks = [];
  for (const rawLine of sseText.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { chunks.push(JSON.parse(data)); } catch { /* skip malformed */ }
  }

  let id = ''; let model = ''; let created = 0; let finishReason = 'stop'; let usage = null;
  let content = ''; let reasoning = '';
  const toolCalls = {};

  for (const c of chunks) {
    if (c.id) id = c.id;
    if (c.model) model = c.model;
    if (c.created) created = c.created;
    if (c.usage) usage = c.usage;
    const choice = (c.choices || [])[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index || 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.type) toolCalls[idx].type = tc.type;
        if (tc.function) {
          if (tc.function.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  const toolCallList = Object.keys(toolCalls).sort().map((k) => toolCalls[k]);
  if (toolCallList.length) {
    message.tool_calls = toolCallList.map((tc) => ({
      id: tc.id, type: tc.type, function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }

  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

async function handleProxy(req, res, pathname) {
  const upstreamPath = UPSTREAM_MAP[pathname];
  if (!upstreamPath) return false;

  const keyCheck = auth.verifyClientKey(req);
  if (!keyCheck.ok) {
    const status = keyCheck.rateLimited ? 429 : 401;
    util.sendJson(res, status, { error: { message: keyCheck.message, type: 'authentication_error' } });
    return true;
  }

  let body;
  try { body = await util.readBody(req); }
  catch (e) { util.sendJson(res, 400, { error: { message: `read body failed: ${e.message}` } }); return true; }

  let payload = null;
  if (body.length) { try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; } }
  if (payload == null) payload = {};

  const cfg = store.getConfig();
  const timeoutMs = store.getRequestTimeoutMs();
  if (cfg.forceModel) payload.model = cfg.forceModel;
  else if (!payload.model) payload.model = cfg.defaultModel || 'default';

  // 模型名可带渠道前缀（traework/xxx）；无前缀走默认渠道，旧客户端零改动
  const resolved = providers.resolveModel(payload.model);
  const provider = providers.getProvider(resolved.kind);
  if (!provider) {
    util.sendJson(res, 400, { error: { message: `未知渠道: ${resolved.kind}`, type: 'invalid_request_error' } });
    return true;
  }

  /**
   * 自带凭证的渠道（自定义 OpenAI 兼容 endpoint）：不需要账号池、不需要登录。
   * 这里直接用模型前缀定位 endpoint 配置（baseUrl + apiKey），跳过 auth.pickAccountForRequest。
   * 约定：模型前缀即 endpoint 的 model_prefix（或 id）。`oc/gpt-4o` 中 `oc` 命中某 endpoint。
   */
  const selfCredential = typeof provider.isSelfCredential === 'function'
    ? provider.isSelfCredential()
    : (resolved.kind === 'openai-custom');
  let endpoint = null;
  if (selfCredential) {
    if (typeof provider.endpointFor === 'function') {
      // 传入的是「前缀 / endpoint id」（resolved.kind 已为 openai-custom，前缀=裸 model 前的那段）
      // resolved.model 是去掉前缀后的裸模型；前缀需从原始 model 反推：
      const rawPrefix = String(payload.model || '').includes('/')
        ? String(payload.model).slice(0, String(payload.model).indexOf('/'))
        : '';
      endpoint = provider.endpointFor(rawPrefix.toLowerCase()) || provider.lookupByModelPrefix(resolved.model);
    }
    if (!endpoint) {
      // 回退：任意启用的自定义 endpoint（未配多 endpoint 时的默认行为）
      const s = store.listCustomApis ? store : require('./store');
      endpoint = (s.listCustomApis && s.listCustomApis().find((e) => e.enabled)) || null;
    }
    if (!endpoint) {
      util.sendJson(res, 400, {
        error: { message: '未配置可用的自定义 OpenAI 兼容 API，请先在管理页添加', type: 'invalid_request_error' },
      });
      return true;
    }
  }

  const isChat = CHAT_PATHS.has(pathname);
  // Trae SOLO 通道只有 chat 能力；completions/embeddings 仅 CodeBuddy 支持
  if (!isChat && resolved.kind !== 'codebuddy' && resolved.kind !== 'openai-custom') {
    util.sendJson(res, 400, {
      error: { message: `渠道 ${resolved.kind} 仅支持 /v1/chat/completions`, type: 'invalid_request_error' },
    });
    return true;
  }
  // 上游请求体的 model 字段去掉渠道前缀（上游只认裸模型名）
  payload.model = resolved.model;

  const isStream = payload.stream === true;
  const needAggregate = isChat && !isStream;

  if (isChat) {
    // DEBUG dump 记录「净化前」的载荷，便于定位 11128 触发词（仅 CODEBUDDY_DEBUG=1 时启用）
    if (process.env.CODEBUDDY_DEBUG) {
      try {
        let raw = null;
        try { raw = JSON.parse(body.toString('utf8')); } catch { /* ignore */ }
        const dumpPath = require('path').join(require('os').tmpdir(), 'codebuddy-debug-last-chat.json');
        fs.writeFileSync(dumpPath, JSON.stringify({ raw, chat: payload, ts: new Date().toISOString() }, null, 2));
        const rk = Object.keys(payload).filter((k) => /reason|think|effort/i.test(k));
        const rkv = rk.map((k) => `${k}=${JSON.stringify(payload[k])}`).join(' ');
        logger.log('info', 'proxy', `debug dump -> ${dumpPath} | msgs=[${(payload.messages || []).map((m) => `${m.role}:${JSON.stringify(m.content).length}${m.tool_calls ? `(tc:${m.tool_calls.length})` : ''}`).join(',')}] tools=${(payload.tools || []).length} | ${rkv}`);
      } catch { /* ignore */ }
    }
    // 渠道专属请求体改写，只调用一次：
    //   codebuddy -> 竞品词/指纹句净化（绕 11128）
    //   traework  -> 转成 SOLO 格式（developer→system、function_call、stream 强制 true 等）
    //   openai-custom -> 原样透传（OpenAI 格式即上游格式）
    if (typeof provider.preparePayload === 'function') provider.preparePayload(payload, endpoint);
  }

  if (needAggregate) payload.stream = true;
  const jsonBody = JSON.stringify(payload);
  // 记录用户原始请求形态：上游只支持流式，非流式是本地聚合的，
  // 若用改写后的 payload.stream 会把非流式请求误记为流式。
  const recordStream = isStream;

  // 自带凭证渠道：跳过账号池，直接以 endpoint 作为「账号视图」
  const accountKey = auth.extractAccountKey(req, payload);
  // 会话粘性：同一段对话固定落在同一账号。没有它时每个请求都轮换账号，
  // agent 跑十几步工具调用就换十几个账号，prompt cache 命中率几乎归零。
  const sessionKey = auth.extractSessionKey(req, payload, resolved.kind, keyCheck.keyId || '');
  // 客户端声明「这段对话结束了」（X-Session-End）时释放绑定，下一段对话可以重新分配。
  // 挂在 res 的 close 上：流式/非流式、正常/异常的所有出口都会走到。
  if (sessionKey && auth.isSessionEnd(req, payload)) {
    res.on('close', () => { try { sessionModRelease(sessionKey); } catch { /* ignore */ } });
  }
  let acct;
  if (selfCredential) {
    acct = endpoint; // 透传给 buildChatHeaders（openai-custom.buildChatHeaders 只吃 ep）
  } else {
    try { acct = await auth.pickAccountForRequest(accountKey, keyCheck.accountId || '', resolved.kind, sessionKey); }
    catch (e) {
      logger.log('warn', 'proxy', `${pathname} 拒绝: ${e.message}`, { pathname, model: payload.model, provider: resolved.kind });
      util.sendJson(res, 401, { error: { message: e.message, type: 'authentication_error' } });
      return true;
    }
  }

  const accountId = acct ? (acct.id || acct.baseUrl || '') : '';
  const accountName = acct ? (acct.name || (acct.account && (acct.account.nickname || acct.account.uid)) || acct.baseUrl || '') : '';

  // 记录一次用量
  const record = (usage, status) => {
    store.recordUsage({
      source: pathname,
      model: payload.model || '',
      stream: recordStream,
      accountId, accountName,
      apiKeyId: keyCheck.keyId || '', apiKeyName: keyCheck.keyName || '',
      promptTokens: usage && usage.prompt_tokens,
      completionTokens: usage && usage.completion_tokens,
      totalTokens: usage && usage.total_tokens,
      cachedTokens: util.cachedTokensOf(usage),
      durationMs: Date.now() - startedAt,
      status,
    });
  };

  const headers = {
    ...provider.buildChatHeaders(acct),
    'Content-Type': 'application/json',
    // 官方 CLI 即使流式也发 Accept: application/json（服务端按 body.stream 返回 SSE）；
    // Trae / 自定义兼容 endpoint 侧由 provider 自己的头决定 Accept，故仅在缺省时补
    'Accept': headersAcceptFor(resolved.kind),
  };
  // 目标地址：自带凭证渠道直接用 endpoint 的 baseUrl 拼路径；其它渠道沿用旧逻辑
  let targetUrl;
  if (selfCredential && endpoint) {
    targetUrl = isChat ? provider.chatUrl(endpoint) : (upstreamPath === '/v1/embeddings' || upstreamPath === '/v2/embeddings' ? provider.embeddingsUrl(endpoint) : provider.completionsUrl(endpoint));
  } else {
    targetUrl = isChat ? provider.chatUrl(acct) : `${config.ENDPOINT}${upstreamPath}`;
  }
  const startedAt = Date.now();
  // 渠道专属流转换器（Trae 的 SOLO 事件流需要转换；CodeBuddy / 自定义兼容 endpoint 返回 null 走默认路径）
  const converter = isChat && isStream && typeof provider.createSseConverter === 'function'
    ? provider.createSseConverter() : null;
  const aggregateFn = isChat && typeof provider.aggregate === 'function'
    ? provider.aggregate : aggregateSseToCompletion;

  /**
   * 上游「空错误体」的兜底判断。
   *
   * 某些上游报错时只给状态码、不给 body（实测腾讯 CodeBuddy）。客户端拿到
   * `400 (no body)` 后无法把错误归类为上下文溢出，也就不会触发「压缩后重试」，
   * 只能把原始错误抛给用户。
   *
   * 这里用请求体字节数粗估 prompt token（中英混排约 3 字节/token），与该模型
   * 已知的上下文窗口比较：只有确实逼近/超过窗口时才标记为溢出，避免误触发
   * 客户端的压缩（那会白白压掉一次上下文细节）。
   */
  const errFallback = (() => {
    const win = isChat ? models.contextWindowOf(resolved.kind, resolved.model) : 0;
    const approxPromptTokens = Math.ceil(Buffer.byteLength(jsonBody, 'utf8') / 3);
    const overflow = win > 0 && approxPromptTokens > win * 0.9;
    return {
      overflow,
      detail: `model=${resolved.model}, approxPromptTokens≈${approxPromptTokens}`
        + (win > 0 ? `, contextWindow=${win}` : ', contextWindow=unknown'),
    };
  })();

  try {
    if (needAggregate) {
      const r = await util.requestRaw(targetUrl, { method: 'POST', headers, body: jsonBody, timeoutMs });
      const ct = (r.headers && r.headers['content-type']) || '';
      const looksSse = ct.includes('text/event-stream') || r.body.includes('chat.completion.chunk');
      // 上游报错时直接透传，不要当成 SSE 去聚合（否则错误体会被聚合成空回复）
      const upstreamOk = r.status >= 200 && r.status < 300;
      if (upstreamOk && (looksSse || resolved.kind !== 'codebuddy')) {
        const completion = aggregateFn(r.body);
        logger.log('info', 'proxy', `${pathname} 完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, status: 200, durationMs: Date.now() - startedAt, tokens: completion.usage && completion.usage.total_tokens }));
        record(completion.usage, 'ok');
        util.sendJson(res, 200, completion);
      } else {
        logger.log('warn', 'proxy', `${pathname} 上游非流式响应 ${r.status}`, logger.requestSummary(payload, { status: r.status, durationMs: Date.now() - startedAt }));
        record(null, upstreamOk ? 'ok' : 'error');
        // 上游错误体为空时合成一个：否则客户端只看到 "(no body)"，既无法诊断也识别不了溢出
        const emptyErr = !upstreamOk && !String(r.body || '').trim();
        const outBody = emptyErr ? util.synthesizeUpstreamError(r.status, errFallback) : r.body;
        res.writeHead(r.status, {
          'Content-Type': emptyErr ? 'application/json; charset=utf-8' : (ct || 'application/json'),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(outBody);
      }
    } else if (isStream) {
      await util.pipeSseToClient(res, targetUrl, {
        method: 'POST', headers, body: jsonBody, converter, errorFallback: errFallback,
        extraHeaders: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
      }, ({ usage, status }) => record(usage, status));
      logger.log('info', 'proxy', `${pathname} 流式结束 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: true, durationMs: Date.now() - startedAt }));
    } else {
      const r = await util.requestJson(targetUrl, { method: 'POST', headers, body: jsonBody, timeoutMs });
      logger.log('info', 'proxy', `${pathname} 完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, status: r.status, durationMs: Date.now() - startedAt }));
      record(r.json && r.json.usage, r.status === 200 ? 'ok' : 'error');
      const emptyErr = r.status >= 300 && !String(r.body || '').trim();
      const outBody = emptyErr ? util.synthesizeUpstreamError(r.status, errFallback) : r.body;
      res.writeHead(r.status, {
        'Content-Type': emptyErr ? 'application/json; charset=utf-8' : ((r.headers && r.headers['content-type']) || 'application/json'),
        'Access-Control-Allow-Origin': '*',
      });
      res.end(outBody);
    }
  } catch (e) {
    logger.log('error', 'proxy', `${pathname} 上游错误: ${e.message}`, logger.requestSummary(payload, { stream: isStream, durationMs: Date.now() - startedAt }));
    record(null, 'error');
    if (!res.headersSent) util.sendJson(res, 502, { error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } });
    else res.end();
  }
  return true;
}

/** CodeBuddy 官方 CLI 即使流式也发 Accept: application/json；Trae 需 text/event-stream */
function headersAcceptFor(kind) {
  return kind === 'codebuddy' ? 'application/json' : 'text/event-stream';
}

module.exports = { UPSTREAM_MAP, aggregateSseToCompletion, handleProxy };
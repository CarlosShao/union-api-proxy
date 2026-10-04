'use strict';

/** Responses API 转换（Codex 用 /v1/responses） */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const auth = require('./auth');
const openai = require('./openai');
const sanitize = require('./sanitize');
const providers = require('./providers/all');

// CodeBuddy 后端的内容过滤器会拦截含 "Codex"/"OpenAI" 等竞品品牌词的系统提示词，
// 返回 11128 "Illegal API invocation from an unapproved channel"。净化规则统一在 core/sanitize.js。

/**
 * 从 Responses / Chat 两套写法里取出图片地址。
 * Responses 的 input_image 是 { type:'input_image', image_url: '<字符串>', detail }，
 * Chat Completions 的 image_url 是 { type:'image_url', image_url:{ url, detail } }，
 * 两种都要认，否则图片会被降级成纯文本。
 */
function extractImageUrl(c) {
  const raw = c.image_url !== undefined ? c.image_url : c.url;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return raw.url || '';
  return '';
}

/** 转成 chat/completions 认识的 image_url 分片（Responses 的 detail 也带过去） */
function toImagePart(c) {
  const url = extractImageUrl(c);
  if (!url) return null;
  const detail = c.detail || (c.image_url && typeof c.image_url === 'object' && c.image_url.detail) || undefined;
  return { type: 'image_url', image_url: detail ? { url, detail } : { url } };
}

/**
 * Responses 的 content → chat/completions 的 content。
 *
 * 纯文本时返回字符串（保持原样，兼容只吃字符串的上游）；只要含图片/音频等
 * 非文本分片，就返回分片数组，避免多模态信息被压平成文本。
 *
 * clean 是**函数**而非布尔开关：本地的净化分两级——系统/开发者消息走
 * sanitizeText（词 + 短语），用户 / 工具消息只走 sanitizePhrase（仅短语），
 * 照搬上游的布尔开关会让用户消息重新开始替换竞品词，改坏用户内容。
 */
function contentToChat(content, clean) {
  const fn = typeof clean === 'function' ? clean : (s) => s;

  if (content == null) return '';
  if (typeof content === 'string') return fn(content);
  if (!Array.isArray(content)) {
    if (typeof content === 'object') return contentToChat([content], fn);
    return fn(String(content));
  }

  const textParts = [];
  const parts = [];
  let hasNonText = false;

  for (const c of content) {
    if (typeof c === 'string') { textParts.push(c); parts.push({ type: 'text', text: fn(c) }); continue; }
    if (!c || typeof c !== 'object') continue;

    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') {
      const t = c.text || '';
      textParts.push(t);
      parts.push({ type: 'text', text: fn(t) });
      continue;
    }
    if (c.type === 'input_image' || c.type === 'image_url' || c.type === 'image') {
      const part = toImagePart(c);
      if (part) { hasNonText = true; parts.push(part); }
      continue;
    }
    if (c.type === 'input_audio' || c.type === 'audio' || c.type === 'input_file' || c.type === 'file') {
      // 上游不一定支持，但至少原样带过去，而不是静默丢掉
      hasNonText = true;
      parts.push(c);
      continue;
    }
    if (c.type === 'refusal') { textParts.push(c.refusal || ''); parts.push({ type: 'text', text: fn(c.refusal || '') }); continue; }
    // 未知分片类型：保留，避免信息静默丢失
    hasNonText = true;
    parts.push(c);
  }

  if (!hasNonText) return fn(textParts.filter(Boolean).join('\n'));
  return parts;
}

/** 只要文本（tool 输出等纯文本场景仍用它） */
function contentToText(content) {
  const r = contentToChat(content);
  if (typeof r === 'string') return r;
  return r.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'required') return 'required';
    if (tc === 'none') return 'none';
    return 'auto';
  }
  if (typeof tc === 'object') {
    if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
    if (tc.type === 'none') return 'none';
    if (tc.type === 'required') return 'required';
  }
  return 'auto';
}

/**
 * Responses API 请求 → chat/completions 请求。
 * opts.sanitize：是否做竞品词净化。仅 CodeBuddy 需要（11128 拦截是其独有机制），
 * 其它渠道必须关闭 —— 盲目替换会改坏用户内容。
 */
function responsesToChatInput(p, opts) {
  const doSanitize = !opts || opts.sanitize !== false;
  const sysText = (s) => (doSanitize ? sanitize.sanitizeText(s) : s);
  const phraseText = (s) => (doSanitize ? sanitize.sanitizePhrase(s) : s);
  const cfg = store.getConfig();
  const chat = { model: (p.model && p.model !== '') ? p.model : (cfg.defaultModel || 'default'), messages: [], stream: !!p.stream };

  if (p.instructions) chat.messages.push({ role: 'system', content: sysText(p.instructions) });

  const input = p.input;
  if (typeof input === 'string') {
    chat.messages.push({ role: 'user', content: phraseText(input) });
  } else if (Array.isArray(input)) {
    let pendingToolCalls = [];
    const flushToolCalls = () => {
      if (pendingToolCalls.length) {
        chat.messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
        pendingToolCalls = [];
      }
    };
    for (const item of input) {
      if (typeof item === 'string') { flushToolCalls(); chat.messages.push({ role: 'user', content: phraseText(item) }); continue; }
      if (!item || typeof item !== 'object') continue;

      if (item.role && item.content !== undefined) {
        flushToolCalls();
        const isSys = item.role === 'developer' || item.role === 'system';
        const role = item.role === 'developer' ? 'system' : item.role;
        chat.messages.push({ role, content: contentToChat(item.content, isSys ? sysText : phraseText) });
        continue;
      }
      if (item.type === 'message') {
        flushToolCalls();
        const isSys = item.role === 'developer' || item.role === 'system';
        const role = item.role === 'developer' ? 'system' : (item.role || 'user');
        chat.messages.push({ role, content: contentToChat(item.content, isSys ? sysText : phraseText) });
      } else if (item.type === 'function_call') {
        pendingToolCalls.push({
          id: item.call_id || item.id || util.genId('call'),
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '' },
        });
      } else if (item.type === 'function_call_output') {
        flushToolCalls();
        chat.messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: phraseText(contentToText(item.output)) });
      }
    }
    flushToolCalls();
  }

  if (Array.isArray(p.tools) && p.tools.length) {
    chat.tools = p.tools
      .filter((t) => t && t.type === 'function' && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: sysText(t.description || ''),
          parameters: t.parameters || t.input_schema || { type: 'object', properties: {} },
        },
      }));
    if (chat.tools.length) {
      const tc = convertToolChoice(p.tool_choice);
      if (tc) chat.tool_choice = tc;
    }
  }

  if (p.max_output_tokens) chat.max_tokens = p.max_output_tokens;
  if (p.temperature !== undefined) chat.temperature = p.temperature;
  if (p.top_p !== undefined) chat.top_p = p.top_p;

  // 思考强度：Responses API 用 reasoning:{effort} 表达思考档位，但上游只认 chat 的
  // `reasoning_effort` 字符串。这里先原样带到 chatPayload，再由渠道的 preparePayload
  // （CodeBuddy 见 util.resolveReasoningEffort）统一归一化——Responses 请求体里的
  // reasoning 对象会被上游 Go 反序列化拒绝，必须在这里转掉，不能直接透传。
  if (p.reasoning !== undefined) chat.reasoning = p.reasoning;
  if (p.reasoning_effort !== undefined) chat.reasoning_effort = p.reasoning_effort;
  if (p.reasoningEffort !== undefined) chat.reasoningEffort = p.reasoningEffort;
  if (p.thinking !== undefined) chat.thinking = p.thinking;
  if (p.enableThinking !== undefined) chat.enableThinking = p.enableThinking;

  return chat;
}

/** 把 chat usage 转成 Responses API usage 格式 */
function convertUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: util.cachedTokensOf(u) },
    output_tokens: u.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
    total_tokens: u.total_tokens || 0,
  };
}

/** 构建一个 Responses API 响应对象（output 按固化的 output_index 升序） */
function buildResponseObject(state, status) {
  const done = status === 'completed';
  const items = [];
  // 按 item 首次出现时固化的 oi 排序，保证 output 顺序与流式事件里发出的
  // output_index 严格一致（「先正文、后又来工具」时 message 实际排在后出现的
  // 工具之前；若按类型分组排列就会与事件序列对不上）。
  if (state.reasoningStarted || state.reasoning) {
    items.push({
      oi: state.reasoningIndex == null ? 0 : state.reasoningIndex,
      item: {
        id: state.reasoningId, type: 'reasoning', status: done ? 'completed' : 'in_progress',
        summary: state.reasoning ? [{ type: 'summary_text', text: state.reasoning }] : [],
      },
    });
  }
  for (const t of state.toolCalls) {
    items.push({
      oi: t.oi == null ? 0 : t.oi,
      item: { id: t.id, type: 'function_call', call_id: t.call_id, name: t.name, arguments: t.args, status: done ? 'completed' : 'in_progress' },
    });
  }
  if (state.msgStarted || state.content) {
    items.push({
      oi: state.msgIndex == null ? 0 : state.msgIndex,
      item: { id: state.msgId, type: 'message', status: done ? 'completed' : 'in_progress', role: 'assistant', content: state.content ? [{ type: 'output_text', text: state.content, annotations: [] }] : [] },
    });
  }
  items.sort((a, b) => a.oi - b.oi);
  const output = items.map((x) => x.item);
  return {
    id: state.responseId,
    object: 'response',
    created_at: state.created,
    status,
    error: null,
    incomplete_details: null,
    model: state.model,
    output,
    parallel_tool_calls: true,
    temperature: state.req.temperature ?? 1,
    tool_choice: state.req.tool_choice || 'auto',
    tools: state.req.tools || [],
    max_output_tokens: state.req.max_output_tokens || null,
    instructions: state.req.instructions || null,
    usage: convertUsage(state.usage),
  };
}

/** 把聚合后的 chat.completion 转成 Responses API 非流式响应 */
function chatCompletionToResponse(completion, req) {
  const message = (completion.choices && completion.choices[0] && completion.choices[0].message) || {};
  const output = [];
  const msgId = util.genId('msg');

  if (message.reasoning_content) {
    // reasoning 项的正文放在 summary 里；summary_text 是一个分片对象，
    // 不该再套 annotations，也不该用 content（Responses schema 里 reasoning 项
    // 没有 content 字段，用了属于非规范输出）。
    output.push({
      id: util.genId('rs'), type: 'reasoning', status: 'completed',
      summary: [{ type: 'summary_text', text: message.reasoning_content }],
    });
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    for (const tc of message.tool_calls) {
      output.push({ id: tc.id || util.genId('fc'), type: 'function_call', call_id: tc.id || util.genId('call'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) || '', status: 'completed' });
    }
  }
  const parts = [];
  if (message.content) parts.push({ type: 'output_text', text: message.content, annotations: [] });
  output.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: parts });

  return {
    id: util.genId('resp'),
    object: 'response',
    created_at: completion.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: completion.model || req.model || store.getConfig().defaultModel || 'default',
    output,
    parallel_tool_calls: true,
    temperature: req.temperature ?? 1,
    tool_choice: req.tool_choice || 'auto',
    tools: req.tools || [],
    max_output_tokens: req.max_output_tokens || null,
    instructions: req.instructions || null,
    usage: convertUsage(completion.usage),
  };
}

/**
 * 把上游 chat SSE 流转成 Responses API SSE 事件（边收边写）。
 * converter：可选的渠道专属「上游流 -> OpenAI SSE」转换器（如 Trae 的 SOLO 事件流）。
 *   提供时，上游字节先喂给 feed()，产出的 OpenAI SSE 文本再解析成 Responses 事件。
 */
function streamChatToResponses(clientRes, urlStr, headers, body, originalReq, converter) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;

    const state = {
      seq: 0,
      responseId: util.genId('resp'),
      msgId: util.genId('msg'),
      reasoningId: util.genId('rs'),
      model: originalReq.model || store.getConfig().defaultModel || 'default',
      created: Math.floor(Date.now() / 1000),
      req: originalReq,
      content: '',
      reasoning: '',
      toolCalls: [],
      toolIndex: {},
      started: false,
      reasoningStarted: false,
      nextOutputIndex: 0,
      reasoningIndex: null,
      msgIndex: null,
      msgStarted: false,
      finishReason: 'stop',
      usage: null,
    };

    const emit = (type, data) => {
      data.type = type;
      data.sequence_number = state.seq++;
      clientRes.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const ensureStarted = () => {
      if (state.started) return;
      state.started = true;
      emit('response.created', { response: buildResponseObject(state, 'in_progress') });
      emit('response.in_progress', { response: buildResponseObject(state, 'in_progress') });
    };

    // reasoning 输出项必须排在 message 之前，否则 Codex 的事件顺序校验会失败。
    // 此前上游 delta.reasoning_content 一直被累计到 state 却从不转发，思维链在
    // 流式下完全丢失（只有非流式路径有）。
    const ensureReasoning = () => {
      if (state.reasoningStarted) return;
      state.reasoningStarted = true;
      const oi = state.nextOutputIndex++;
      state.reasoningIndex = oi;
      emit('response.output_item.added', { output_index: oi, item: { id: state.reasoningId, type: 'reasoning', status: 'in_progress', summary: [] } });
      emit('response.reasoning_summary_part.added', { item_id: state.reasoningId, output_index: oi, summary_index: 0, part: { type: 'summary_text', text: '' } });
    };

    // output_index 分配：reasoning（若有）占 0，其后每个 item 按**首次出现顺序**
    // 依次领取并固化一个下标，存在 item 自己的 oi 上。
    //
    // 不能用「基址 + 当前位置」现算（如 outputBase() + toolCalls.length）：
    // 那要求 item 永远连续到达，而「先出正文、之后又来工具调用」时
    // toolCalls.length 会继续增长，同一个 message 的 added 与 done 会算出不同的
    // index（1 vs 2），还会和后来的工具撞号 —— SSE 序列非法。
    const allocOutputIndex = () => state.nextOutputIndex++;
    /** 第 pos 个 function_call 的 output_index（创建时已固化） */
    const toolOutputIndex = (pos) => state.toolCalls[pos].oi;
    /** message 的 output_index（创建时已固化；未开始则为 null） */
    const msgOutputIndex = () => state.msgIndex;

    const ensureMessage = () => {
      if (state.msgStarted) return;
      state.msgStarted = true;
      const oi = allocOutputIndex();
      state.msgIndex = oi;
      emit('response.output_item.added', { output_index: oi, item: { id: state.msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
      emit('response.content_part.added', { item_id: state.msgId, output_index: oi, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    };

    const onChunk = (chunk) => {
      ensureStarted();
      const choice = (chunk.choices || [])[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (chunk.model) state.model = chunk.model;
      if (chunk.created) state.created = chunk.created;
      if (chunk.usage) state.usage = chunk.usage;
      if (choice.finish_reason) state.finishReason = choice.finish_reason;

      // 先处理 reasoning：它必须整段排在正文/工具调用之前。
      // 注意不能写成 a ?? b ?? c 的级联：当 delta.reasoning 是对象时，
      // 中间分支会求值成 ''（非 nullish），导致读 .content 的第三分支永远不可达。
      const r = delta.reasoning;
      const rc = delta.reasoning_content
        ?? (typeof r === 'string' ? r : (r && typeof r.content === 'string' ? r.content : ''));
      if (typeof rc === 'string' && rc) {
        if (!state.msgStarted && !state.toolCalls.length) {
          ensureReasoning();
          state.reasoning += rc;
          emit('response.reasoning_summary_text.delta', { item_id: state.reasoningId, output_index: state.reasoningIndex, summary_index: 0, delta: rc });
        } else {
          // 正文/工具调用已开始后才吐 reasoning：此时再插 reasoning 会破坏已发出的
          // output_index（reasoning 必须占 0），只能累加到 state 里，供最终
          // response.completed 的 output 使用；流式事件不再补发，避免序列自相矛盾。
          state.reasoning += rc;
        }
      }

      if (typeof delta.content === 'string' && delta.content) {
        ensureMessage();
        state.content += delta.content;
        emit('response.output_text.delta', { item_id: state.msgId, output_index: msgOutputIndex(), content_index: 0, delta: delta.content });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          if (!(idx in state.toolIndex)) {
            const pos = state.toolCalls.length;
            state.toolIndex[idx] = pos;
            const id = tc.id || util.genId('fc');
            // oi 在创建时分配并固化，done 阶段直接复用，保证同一 item 的
            // added/done 拿到相同 output_index。
            const oi = allocOutputIndex();
            state.toolCalls.push({ id, call_id: id, name: '', args: '', oi });
            emit('response.output_item.added', { output_index: oi, item: { id, type: 'function_call', call_id: id, name: '', arguments: '', status: 'in_progress' } });
          }
          const pos = state.toolIndex[idx];
          const t = state.toolCalls[pos];
          if (tc.id) { t.id = tc.id; t.call_id = tc.id; }
          if (tc.function) {
            if (tc.function.name) t.name += tc.function.name;
            if (tc.function.arguments) t.args += tc.function.arguments;
          }
        }
      }
    };

    const finish = () => {
      ensureStarted();
      // item 的完结顺序必须按固化的 output_index 升序，且与 buildResponseObject
      // 里 output 数组的顺序完全一致，否则严格校验的客户端（Codex）会认为
      // 事件序列非法。注意不能按类型分组发：「先正文、后又来工具」时 message
      // 的 oi 夹在两个 function_call 之间。
      const done = [];
      if (state.reasoningStarted) {
        done.push({
          oi: state.reasoningIndex,
          run: () => {
            emit('response.reasoning_summary_text.done', { item_id: state.reasoningId, output_index: state.reasoningIndex, summary_index: 0, text: state.reasoning });
            emit('response.reasoning_summary_part.done', { item_id: state.reasoningId, output_index: state.reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: state.reasoning } });
            emit('response.output_item.done', { output_index: state.reasoningIndex, item: { id: state.reasoningId, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: state.reasoning }] } });
          },
        });
      }
      for (const t of state.toolCalls) {
        done.push({
          oi: toolOutputIndex(state.toolCalls.indexOf(t)),
          run: () => emit('response.output_item.done', { output_index: t.oi, item: { id: t.id, type: 'function_call', call_id: t.call_id, name: t.name, arguments: t.args, status: 'completed' } }),
        });
      }
      if (state.msgStarted) {
        done.push({
          oi: msgOutputIndex(),
          run: () => {
            const oi = msgOutputIndex();
            emit('response.output_text.done', { item_id: state.msgId, output_index: oi, content_index: 0, text: state.content });
            emit('response.content_part.done', { item_id: state.msgId, output_index: oi, content_index: 0, part: { type: 'output_text', text: state.content, annotations: [] } });
            emit('response.output_item.done', { output_index: oi, item: { id: state.msgId, type: 'message', status: 'completed', role: 'assistant', content: state.content ? [{ type: 'output_text', text: state.content, annotations: [] }] : [] } });
          },
        });
      }
      done.sort((a, b) => (a.oi || 0) - (b.oi || 0));
      for (const d of done) d.run();
      emit('response.completed', { response: buildResponseObject(state, 'completed') });
      clientRes.end();
    };

    /** 从一段 OpenAI SSE 文本里逐个解析 data 块并回调（两种上游路径共用） */
    const consumeSseText = (text) => {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { onChunk(JSON.parse(data)); } catch { /* skip */ }
      }
    };

    const req = mod.request(u, { method: 'POST', headers, agent: util.agentFor(u.protocol) }, (upRes) => {
      const ct = (upRes.headers['content-type'] || '');
      const upstreamOk = upRes.statusCode >= 200 && upRes.statusCode < 300;
      // 上游报错一律原样透传（含状态码），不要尝试解析成 Responses 事件
      if (!upstreamOk) {
        let errBody = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (c) => { errBody += c; });
        upRes.on('end', () => {
          logger.log('error', 'responses', `上游非 2xx 响应 ${upRes.statusCode}: ${errBody.slice(0, 500)}`);
          if (!clientRes.headersSent) {
            clientRes.writeHead(upRes.statusCode || 502, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
            clientRes.end(errBody);
          } else {
            const ev = { type: 'response.failed', sequence_number: state.seq++, response: { id: state.responseId, object: 'response', status: 'failed', error: { code: 'upstream_error', message: `上游返回 ${upRes.statusCode}: ${errBody.slice(0, 300)}` } } };
            clientRes.write(`event: response.failed\ndata: ${JSON.stringify(ev)}\n\n`);
            clientRes.end();
          }
          resolve({ usage: state.usage, model: state.model, status: 'error' });
        });
        upRes.on('error', reject);
        return;
      }
      // 非转换器模式下，上游必须返回 SSE 才可解析
      if (!converter && !ct.includes('text/event-stream')) {
        let errBody = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (c) => { errBody += c; });
        upRes.on('end', () => {
          logger.log('error', 'responses', `上游非流式响应 ${upRes.statusCode}: ${errBody.slice(0, 500)}`);
          if (!clientRes.headersSent) {
            clientRes.writeHead(upRes.statusCode || 502, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
            clientRes.end(errBody);
          } else {
            const ev = { type: 'response.failed', sequence_number: state.seq++, response: { id: state.responseId, object: 'response', status: 'failed', error: { code: 'upstream_error', message: `上游返回 ${upRes.statusCode}: ${errBody.slice(0, 300)}` } } };
            clientRes.write(`event: response.failed\ndata: ${JSON.stringify(ev)}\n\n`);
            clientRes.end();
          }
          resolve({ usage: state.usage, model: state.model, status: upRes.statusCode === 200 ? 'ok' : 'error' });
        });
        upRes.on('error', reject);
        return;
      }

      if (converter) {
        // 上游为自定义事件流：整段喂给转换器，产出 OpenAI SSE 后再解析
        upRes.setEncoding('utf8');
        upRes.on('data', (chunk) => {
          try { consumeSseText(converter.feed(chunk)); } catch { /* 转换异常不中断流 */ }
        });
        upRes.on('end', () => {
          try { consumeSseText(converter.end()); } catch { /* ignore */ }
          if (!state.usage && typeof converter.getUsage === 'function') {
            try { state.usage = converter.getUsage(); } catch { /* ignore */ }
          }
          finish();
          resolve({ usage: state.usage, model: state.model, status: upRes.statusCode === 200 ? 'ok' : 'error' });
        });
        upRes.on('error', reject);
        return;
      }

      let buf = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          consumeSseText(block);
        }
      });
      upRes.on('end', () => {
        if (buf.trim()) consumeSseText(buf);
        finish();
        resolve({ usage: state.usage, model: state.model, status: upRes.statusCode === 200 ? 'ok' : 'error' });
      });
      upRes.on('error', reject);
    });
    req.on('error', (e) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: `upstream error: ${e.message}` } }));
      }
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}

/** 处理 POST /v1/responses */
async function handleResponses(req, res) {
  const keyCheck = auth.verifyClientKey(req);
  if (!keyCheck.ok) {
    const status = keyCheck.rateLimited ? 429 : 401;
    util.sendJson(res, status, { error: { message: keyCheck.message, type: 'authentication_error' } });
    return;
  }

  let body;
  try { body = await util.readBody(req); }
  catch (e) { util.sendJson(res, 400, { error: { message: `read body failed: ${e.message}` } }); return; }

  let payload = null;
  if (body.length) { try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; } }
  if (payload == null) payload = {};

  const cfg = store.getConfig();
  // 先解析渠道：净化策略与请求体改写都取决于渠道
  const reqModel = cfg.forceModel || payload.model || cfg.defaultModel || 'default';
  const resolved = providers.resolveModel(reqModel);
  const provider = providers.getProvider(resolved.kind);
  if (!provider) {
    util.sendJson(res, 400, { error: { message: `未知渠道: ${resolved.kind}`, type: 'invalid_request_error' } });
    return;
  }

  // 净化仅对 CodeBuddy 生效（11128 竞品词拦截是其独有机制）
  const chatPayload = responsesToChatInput(payload, { sanitize: resolved.kind === 'codebuddy' });
  chatPayload.model = resolved.model;
  chatPayload.stream = true; // 上游仅支持流式（Trae 同样如此）
  if (typeof provider.preparePayload === 'function') provider.preparePayload(chatPayload);

  const timeoutMs = store.getRequestTimeoutMs();
  logger.log('info', 'responses', `model=${payload.model || chatPayload.model} provider=${resolved.kind} stream=${!!payload.stream} messages=${chatPayload.messages.length}`, logger.requestSummary(payload, { messages: chatPayload.messages.length }));

  if (process.env.CODEBUDDY_DEBUG) {
    try {
      fs.writeFileSync('/tmp/codebuddy-debug-last.json', JSON.stringify({ raw: payload, chat: chatPayload }, null, 2));
      logger.log('info', 'responses', `debug dump -> /tmp/codebuddy-debug-last.json | msgs=[${chatPayload.messages.map(m => `${m.role}:${JSON.stringify(m.content).length}${m.tool_calls ? `(tc:${m.tool_calls.length})` : ''}`).join(',')}] tools=[${(chatPayload.tools || []).map(t => t.function.name).join(',')}]`);
    } catch { /* ignore */ }
  }

  const accountKey = auth.extractAccountKey(req, payload);
  let acct;
  try { acct = await auth.pickAccountForRequest(accountKey, keyCheck.accountId || '', resolved.kind); }
  catch (e) {
    logger.log('warn', 'responses', `拒绝: ${e.message}`);
    util.sendJson(res, 401, { error: { message: e.message, type: 'authentication_error' } });
    return;
  }

  const accountId = acct ? acct.id : '';
  const accountName = acct ? (acct.name || (acct.account && (acct.account.nickname || acct.account.uid)) || '') : '';
  const record = (usage, status) => {
    const cached = util.cachedTokensOf(usage);
    store.recordUsage({
      source: '/v1/responses',
      model: chatPayload.model || payload.model || '',
      stream: !!payload.stream,
      accountId, accountName,
      apiKeyId: keyCheck.keyId || '', apiKeyName: keyCheck.keyName || '',
      promptTokens: usage && (usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens),
      completionTokens: usage && (usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens),
      totalTokens: usage && (usage.total_tokens != null ? usage.total_tokens : (usage.input_tokens + usage.output_tokens)),
      cachedTokens: cached,
      durationMs: Date.now() - startedAt,
      status,
    });
  };

  // 按渠道取请求头与上行地址（Trae 用 Cloud-IDE-JWT + 设备指纹，CodeBuddy 用 CLI 身份头）
  const headers = { ...provider.buildChatHeaders(acct), 'Content-Type': 'application/json' };
  if (resolved.kind === 'codebuddy') headers['Accept'] = 'application/json';
  const targetUrl = provider.chatUrl(acct);
  const jsonBody = JSON.stringify(chatPayload);
  const startedAt = Date.now();
  const converter = typeof provider.createSseConverter === 'function' ? provider.createSseConverter() : null;

  try {
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
      const done = await streamChatToResponses(res, targetUrl, headers, jsonBody, payload, converter);
      logger.log('info', 'responses', `流式结束 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: true, durationMs: Date.now() - startedAt }));
      record(done && done.usage, (done && done.status) || 'ok');
    } else {
      const r = await util.requestRaw(targetUrl, { method: 'POST', headers, body: jsonBody, timeoutMs });
      const ct = (r.headers && r.headers['content-type']) || '';
      if (ct.includes('text/event-stream') || r.body.includes('chat.completion.chunk') || resolved.kind !== 'codebuddy') {
        const completion = typeof provider.aggregate === 'function'
          ? provider.aggregate(r.body) : openai.aggregateSseToCompletion(r.body);
        logger.log('info', 'responses', `完成 (${Date.now() - startedAt}ms)`, logger.requestSummary(payload, { stream: false, durationMs: Date.now() - startedAt, tokens: completion.usage && completion.usage.total_tokens }));
        record(completion.usage, 'ok');
        util.sendJson(res, 200, chatCompletionToResponse(completion, payload));
      } else {
        record(null, r.status === 200 ? 'ok' : 'error');
        res.writeHead(r.status, { 'Content-Type': ct || 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(r.body);
      }
    }
  } catch (e) {
    logger.log('error', 'responses', `上游错误: ${e.message}`, logger.requestSummary(payload, { durationMs: Date.now() - startedAt }));
    record(null, 'error');
    if (!res.headersSent) util.sendJson(res, 502, { error: { message: `upstream error: ${e.message}`, type: 'proxy_upstream_error' } });
    else res.end();
  }
}

// responsesToChatInput / streamChatToResponses 导出以便回归测试直接驱动（见 test/responses-stream.js）
module.exports = { handleResponses, responsesToChatInput, streamChatToResponses };
'use strict';

/**
 * Trae SOLO 自定义事件流 -> OpenAI SSE 转换（流式转换 + 非流式聚合）。
 *
 * 上游事件序列（实测，非标准 OpenAI SSE）：
 *   event:metadata      data:{"model":"","session_id":"..."}
 *   event:timing_cost   data:{"name":"llm_raw_chat_v2",...}
 *   event:output        data:{"response":"<正文增量>","reasoning_content":"<思考增量>","tool_calls":null}
 *   event:extra_info    data:{...}                  （含完整 reasoning，忽略）
 *   event:token_usage   data:{"prompt_tokens":..,"completion_tokens":..,"total_tokens":..,"reasoning_tokens":..}
 *   event:done          data:{"finish_reason":"stop"}
 *   event:error         data:{"code":1005,"message":"..."}
 *
 * 转换要点：**只发射非空字段**的 delta。上游 output 事件常在思考阶段带 response:""，
 * 若照样下发，AI SDK 会把每个空块切成独立的 reasoning 片段（UI 表现为几十上百个
 * 「思考·持续了几秒」）。这里从源头保证 delta 不携带空字段。
 */

/**
 * 解析单条 SOLO 事件。
 * @returns {{event,response,reasoning,toolCalls,usage,finishReason,errorCode,errorMessage}}
 */
function parseSOLOEvent(eventName, dataLine) {
  const ev = {
    event: String(eventName || '').trim(),
    response: '', reasoning: '', toolCalls: undefined,
    usage: null, finishReason: '', errorCode: 0, errorMessage: '',
  };
  if (!dataLine) return ev;
  let raw;
  try { raw = JSON.parse(dataLine); } catch { return ev; }
  if (!raw || typeof raw !== 'object') return ev;

  switch (ev.event) {
    case 'output':
      if (typeof raw.response === 'string') ev.response = raw.response;
      if (typeof raw.reasoning_content === 'string') ev.reasoning = raw.reasoning_content;
      if (raw.tool_calls !== undefined && raw.tool_calls !== null) ev.toolCalls = raw.tool_calls;
      break;
    case 'token_usage':
      ev.usage = raw;
      break;
    case 'done':
      if (typeof raw.finish_reason === 'string') ev.finishReason = raw.finish_reason;
      break;
    case 'error':
      if (typeof raw.code === 'number') ev.errorCode = raw.code;
      else if (typeof raw.code === 'string') ev.errorCode = parseInt(raw.code, 10) || 0;
      if (typeof raw.message === 'string') ev.errorMessage = raw.message;
      break;
    default:
      break;
  }
  return ev;
}

/** 把 SOLO tool_call 条目归一化为 OpenAI 标准结构（function_call -> function，清理私有字段） */
function normalizeToolCalls(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const call of list) {
    if (!call || typeof call !== 'object') continue;
    const c = { ...call };
    if (c.function_call && typeof c.function_call === 'object') {
      c.function = c.function_call;
      delete c.function_call;
    }
    if (c.function && typeof c.function === 'object') {
      // 上游私有字段，OpenAI 客户端不认
      delete c.function.namespace;
      delete c.function.partial_arguments;
    }
    out.push(c);
  }
  return out.length ? out : null;
}

/** 生成一个 chat.completion.chunk 的 SSE 文本块 */
function chunkText(state, delta, finishReason) {
  const chunk = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta }],
  };
  if (finishReason) chunk.choices[0].finish_reason = finishReason;
  if (state.pendingUsage) {
    chunk.usage = state.pendingUsage;
    state.pendingUsage = null;
  }
  return 'data: ' + JSON.stringify(chunk) + '\n\n';
}

/**
 * 创建流式转换器。
 * feed(chunk) 返回可直接写给客户端的 OpenAI SSE 文本（可能为空串）。
 * end() 返回收尾文本（补 [DONE]）。
 */
function createSseConverter() {
  const state = {
    id: 'chatcmpl-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
    created: Math.floor(Date.now() / 1000),
    model: '',
    eventName: '',
    dataBuf: '',
    lineBuf: '',
    pendingUsage: null,
    sawDone: false,
    sawContent: false,
  };

  /** 处理一条已解析事件，返回要下发的 SSE 文本 */
  function handleEvent(ev) {
    let out = '';
    switch (ev.event) {
      case 'metadata':
        // 上游 metadata 里的 model 为空，保留默认
        break;
      case 'output': {
        const delta = {};
        if (ev.response) { delta.content = ev.response; state.sawContent = true; }
        if (ev.reasoning) delta.reasoning_content = ev.reasoning;
        if (ev.toolCalls !== undefined) {
          const tc = normalizeToolCalls(ev.toolCalls);
          if (tc) delta.tool_calls = tc;
        }
        // 关键：delta 为空则不下发，避免上游空字段污染下游
        if (Object.keys(delta).length) out += chunkText(state, delta, '');
        break;
      }
      case 'token_usage':
        state.pendingUsage = ev.usage;
        break;
      case 'done':
        // 上游 error 事件后常跟 done，避免重复收尾（[DONE] 之后不应再有帧）
        if (state.sawDone) break;
        out += chunkText(state, {}, ev.finishReason || 'stop');
        out += 'data: [DONE]\n\n';
        state.sawDone = true;
        break;
      case 'error': {
        // 以 OpenAI 错误对象透传（不再伪装成正文，避免客户端把失败当正常回复）。
        // 正文已流出时补收尾帧让流干净终止；否则直接错误 + [DONE]，SDK 会抛错。
        out += 'data: ' + JSON.stringify(buildUpstreamError(ev.errorCode, ev.errorMessage)) + '\n\n';
        if (state.sawContent) out += chunkText(state, {}, 'stop');
        out += 'data: [DONE]\n\n';
        state.sawDone = true;
        break;
      }
      default:
        break; // timing_cost / extra_info 直接忽略
    }
    return out;
  }

  /** 处理一行文本（含事件边界识别） */
  function handleLine(line, sink) {
    if (line === '') {
      if (!state.eventName) return;
      const ev = parseSOLOEvent(state.eventName, state.dataBuf);
      state.eventName = '';
      state.dataBuf = '';
      const out = handleEvent(ev);
      if (out) sink.push(out);
      return;
    }
    if (line.startsWith('event:')) {
      state.eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      state.dataBuf += line.slice(5).replace(/^ /, '');
      return;
    }
    // ':' 开头为注释，其余忽略
  }

  return {
    feed(chunk) {
      state.lineBuf += chunk;
      const sink = [];
      let idx;
      while ((idx = state.lineBuf.indexOf('\n')) !== -1) {
        const line = state.lineBuf.slice(0, idx).replace(/\r$/, '');
        state.lineBuf = state.lineBuf.slice(idx + 1);
        handleLine(line, sink);
      }
      // 事件自带尾部空行，若上游用 \r\n 则上面已剥离 \r
      return sink.join('');
    },
    end() {
      const sink = [];
      // 处理残留的完整行 / 未终止的最后一行
      if (state.lineBuf) {
        const line = state.lineBuf.replace(/\r$/, '');
        state.lineBuf = '';
        handleLine(line, sink);
      }
      // 事件缓冲里还有未提交的事件（上游未以空行结尾）
      if (state.eventName) {
        const ev = parseSOLOEvent(state.eventName, state.dataBuf);
        state.eventName = '';
        state.dataBuf = '';
        const out = handleEvent(ev);
        if (out) sink.push(out);
      }
      // 上游中途断开：补 finish_reason 与 [DONE]，避免客户端一直等
      if (!state.sawDone) {
        sink.push(chunkText(state, {}, 'stop'));
        sink.push('data: [DONE]\n\n');
        state.sawDone = true;
      }
      return sink.join('');
    },
    /** 供 usage 记录使用 */
    getUsage() { return state.pendingUsage; },
  };
}

/**
 * 非流式：读完整段 SOLO 事件流，聚合成单个 OpenAI chat.completion。
 * @param {string} sseText 上游原始响应体
 * @returns {object} chat.completion
 */
function aggregate(sseText) {
  const text = String(sseText || '');
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));

  let eventName = '';
  let dataBuf = '';
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = null;
  let upstreamError = null;
  const toolCalls = new Map();

  const flush = () => {
    const ev = parseSOLOEvent(eventName, dataBuf);
    eventName = '';
    dataBuf = '';
    switch (ev.event) {
      case 'output':
        content += ev.response;
        reasoning += ev.reasoning;
        if (ev.toolCalls !== undefined) mergeToolCalls(toolCalls, normalizeToolCalls(ev.toolCalls));
        break;
      case 'token_usage':
        usage = ev.usage;
        break;
      case 'done':
        if (ev.finishReason) finishReason = ev.finishReason;
        break;
      case 'error':
        upstreamError = { code: ev.errorCode, message: ev.errorMessage };
        break;
      default:
        break;
    }
  };

  for (const line of lines) {
    if (line === '') { if (eventName) flush(); continue; }
    if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
    if (line.startsWith('data:')) { dataBuf += line.slice(5).replace(/^ /, ''); continue; }
  }
  if (eventName) flush();

  if (upstreamError) {
    const built = buildUpstreamError(upstreamError.code, upstreamError.message);
    const err = new Error(built.error.message);
    err.upstreamCode = upstreamError.code;
    throw err;
  }

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = Array.from(toolCalls.keys()).sort((a, b) => a - b).map((k) => toolCalls.get(k));
  }

  const completion = {
    id: 'chatcmpl-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) completion.usage = usage;
  return completion;
}

/** 按 index 合并 tool_call 分片：id/type/name 覆盖，arguments 拼接 */
function mergeToolCalls(store, list) {
  if (!Array.isArray(list)) return;
  for (const call of list) {
    const idx = typeof call.index === 'number' ? call.index : 0;
    let merged = store.get(idx);
    if (!merged) {
      merged = { index: idx, id: '', type: 'function', function: { name: '', arguments: '' } };
      store.set(idx, merged);
    }
    if (call.id) merged.id = call.id;
    if (call.type) merged.type = call.type;
    const fn = call.function;
    if (fn && typeof fn === 'object') {
      if (typeof fn.name === 'string' && fn.name) merged.function.name = fn.name;
      if (typeof fn.arguments === 'string' && fn.arguments) {
        merged.function.arguments = (merged.function.arguments || '') + fn.arguments;
      }
    }
  }
}

/**
 * 上游 error 事件 -> OpenAI 错误对象。
 * 4001（参数校验失败）在新上架模型（glm-5.3 系列）上表现为「列表可见但对话通道
 * 未开放」，附提示避免用户误以为是代理故障。
 */
function buildUpstreamError(code, message) {
  let msg = `Trae upstream error code=${code} msg=${message}`;
  if (code === 4001) {
    msg += ' —— 上游拒绝了该模型。若为新上架模型（如 glm-5.3 系列），说明其对话通道尚未对开放接口生效，请先切换其他模型，待上游放开后自动可用';
  }
  return { error: { message: msg, type: 'upstream_error', code: code || null, param: null } };
}

module.exports = { createSseConverter, aggregate, parseSOLOEvent, normalizeToolCalls };

'use strict';

/**
 * OpenAI chat/completions 请求体 -> Trae SOLO `llm_utils_chat` 请求体（原地改写）。
 *
 * 关键改写（照搬 wild-work internal/traework/payload.go 的实测行为）：
 *   1. stream 强制 true —— 上游只支持流式，非流式由本地聚合
 *   2. function=solo_work_lite —— 免费通道标识
 *   3. model 与 config_name 双写（上游读 config_name，兼容读 model）
 *   4. developer -> system —— 上游不认 developer 角色
 *   5. assistant.tool_calls.function -> function_call（上游字段名不同），name 为空则丢弃该项
 *   6. content 字符串 -> [{type:'text', text}] 数组形态
 *   7. tool_choice 归一化（上游该字段是字符串，传对象会 400）
 *   8. tools[].function.parameters 序列化为 JSON 字符串
 */

const C = require('./constants');

function preparePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  payload.stream = true;
  payload.function = C.Function;

  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  const name = model || C.DefaultConfigName;
  payload.model = name;
  payload.config_name = name;

  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'developer') m.role = 'system';

      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        const kept = [];
        for (const tc of m.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          if (tc.function && typeof tc.function === 'object') {
            tc.function_call = tc.function;
            delete tc.function;
          }
          const fc = tc.function_call;
          const fnName = fc && typeof fc.name === 'string' ? fc.name.trim() : '';
          if (!fnName) continue; // 上游会因空 name 报错
          kept.push(tc);
        }
        if (kept.length) m.tool_calls = kept;
        else delete m.tool_calls;
      }

      if (typeof m.content === 'string') {
        m.content = [{ type: 'text', text: m.content }];
      }
      // content 为 null/undefined 时上游不接受，直接移除该字段
      if (m.content === null || m.content === undefined) delete m.content;
      else if (Array.isArray(m.content)) m.content = normalizeParts(m.content);
    }
  }

  normalizeToolChoice(payload);
  normalizeTools(payload);
  return payload;
}

/** 内容分片：OpenAI 的 {type:'text',text} 直接可用，过滤掉无效项 */
function normalizeParts(parts) {
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p === 'string') { out.push({ type: 'text', text: p }); continue; }
    if (typeof p === 'object') {
      if (typeof p.text === 'string') { out.push({ type: 'text', text: p.text }); continue; }
      out.push(p);
    }
  }
  return out;
}

/**
 * tool_choice 归一化（上游为 string 类型）：
 *   "none" / {type:'none'}                  -> 删 tool_choice + tools/functions
 *   {type:'auto'|'required'}                -> 字符串
 *   {type:'function',function:{name:'x'}}   -> 字符串 'x'
 *   其它对象/数组                            -> 删字段
 */
function normalizeToolChoice(obj) {
  const suppress = () => { delete obj.tools; delete obj.functions; };
  if (!('tool_choice' in obj)) return;
  const tc = obj.tool_choice;
  if (typeof tc === 'string') {
    if (tc.trim().toLowerCase() === 'none') { delete obj.tool_choice; suppress(); }
    return;
  }
  if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
    const type = String(tc.type || '').trim().toLowerCase();
    if (type === 'none') { delete obj.tool_choice; suppress(); return; }
    if (type === 'auto' || type === 'required') { obj.tool_choice = type; return; }
    if (type === 'function') {
      let nm = '';
      if (tc.function && typeof tc.function.name === 'string') nm = tc.function.name.trim();
      if (!nm && typeof tc.name === 'string') nm = tc.name.trim();
      obj.tool_choice = nm || 'auto';
      return;
    }
    delete obj.tool_choice;
    return;
  }
  delete obj.tool_choice;
}

/** tools[].function.parameters 需为 JSON 字符串（上游按字符串解析） */
function normalizeTools(obj) {
  if (!Array.isArray(obj.tools) || !obj.tools.length) return;
  const kept = [];
  for (const t of obj.tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type !== 'function' || !t.function || typeof t.function !== 'object') continue;
    const p = t.function.parameters;
    if (p && typeof p === 'object') {
      try { t.function.parameters = JSON.stringify(p); } catch { /* 保留原值 */ }
    }
    kept.push(t);
  }
  if (kept.length) obj.tools = kept;
  else delete obj.tools;
}

module.exports = { preparePayload, normalizeToolChoice, normalizeTools };

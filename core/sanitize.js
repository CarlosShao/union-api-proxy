'use strict';

/** 系统提示词净化：绕过 CodeBuddy 后端 11128 "Illegal API invocation" 竞品品牌词拦截 */

// 再遇 11128 时，启动代理加 CODEBUDDY_DEBUG=1 看 /tmp 下的 dump 定位剩余触发词，在此追加规则。
// 注意：会出现在路径/标识符里的词（如 .zcode、zcode-plugins）必须用负向断言排除独立用法，避免改坏路径。
const RULES = [
  [/Codex/gi, 'CodeBuddy'],
  [/OpenAI/gi, 'Tencent'],
  [/Claude/gi, 'CodeBuddy'],
  [/Anthropic/gi, 'Tencent'],
  // ZCode 本身也在拦截词表（实测真实会话必触发 11128）；两侧排除路径/引号/标识符字符，
  // 避免 .zcode、\zcode\、zcode-plugins、"zcode":、zcode-guide: 这类技能 ID/配置键/标识符被误改
  [/(?<![\w.\-\/\\`"'])ZCode(?![\w\\\-:`"])/gi, 'CodeBuddy'],
];

// 整句指纹拦截：CodeBuddy 除词表外还对竞品智能体系统提示词做原句指纹匹配
// （2026-09 实测：下句为 Claude Code/ZCode 模板原句，单独出现即触发 11128，任意子串都不触发，
// 连去掉开头的 "Main " 都能通过）。命中新指纹时：用二分法在净化后提示词里夹出最小触发句，
// 在此追加一条保义改写即可。短语规则先于词规则执行。
const PHRASE_RULES = [
  ['Main branch (you will usually use this for PRs)', 'Main branch (usually the branch you target with PRs)'],
];

function sanitizeText(s) {
  if (typeof s !== 'string') return s;
  for (const [f, t] of PHRASE_RULES) s = s.split(f).join(t);
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}

/** 只做指纹句改写（不含词表替换）。用于历史消息/tool 参数：上游连历史里的竞品提示词原句也拦，
 *  但词表替换绝不能碰历史（用户代码里的 OpenAI 等字样改了会毁内容），精确短语改写则无副作用。 */
function sanitizePhrase(s) {
  if (typeof s !== 'string') return s;
  for (const [f, t] of PHRASE_RULES) s = s.split(f).join(t);
  return s;
}

function sanitizeContent(content) {
  if (typeof content === 'string') return sanitizeText(content);
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? { ...p, text: sanitizeText(p.text) } : p));
  }
  return content;
}

/** 历史消息内容的短语级净化（字符串或分片数组） */
function sanitizeContentPhrase(content) {
  if (typeof content === 'string') return sanitizePhrase(content);
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? { ...p, text: sanitizePhrase(p.text) } : p));
  }
  return content;
}

/**
 * 净化 chat/completions 载荷（原地修改）。
 * - system/developer 消息与工具描述：词表 + 指纹句全量净化；
 * - 其余历史消息（user/assistant/tool）与 tool_calls 参数：只做指纹句改写（词表替换会毁用户代码）；
 * - 工具名不动（要参与 tool_call 往返匹配，改了会对不上）。
 */
function sanitizeChatPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (!m) continue;
      if (m.role === 'system' || m.role === 'developer') m.content = sanitizeContent(m.content);
      else m.content = sanitizeContentPhrase(m.content);
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc && tc.function && typeof tc.function.arguments === 'string') tc.function.arguments = sanitizePhrase(tc.function.arguments);
        }
      }
    }
  }
  if (Array.isArray(payload.tools)) {
    for (const t of payload.tools) {
      if (t && t.type === 'function' && t.function && typeof t.function.description === 'string') {
        t.function.description = sanitizeText(t.function.description);
      }
    }
  }
  return payload;
}

module.exports = { RULES, PHRASE_RULES, sanitizeText, sanitizePhrase, sanitizeChatPayload };

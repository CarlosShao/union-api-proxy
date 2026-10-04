'use strict';
/**
 * 思考强度 / developer 角色归一化的回归测试。
 *
 * 移植自上游 CodeBuddy-API-Proxy 的 a48bb21「归一化 developer 角色与思考强度」。
 *
 * 覆盖两类线上事故：
 *   1. 思考强度未归一化：上游是 Go string 字段，传 bool / 对象会 400 11101；
 *      且**不传**该字段时上游不返回 reasoning_content（思维链静默丢失）。
 *   2. `developer` 角色被上游渠道校验拒绝（400 11128），推理模型下必然踩到。
 *
 * 不依赖网络与登录态。
 */

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const util = require(path.join(ROOT, 'core', 'util.js'));

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

/* ---------------- 思考强度归一化 ---------------- */

check('思考强度：显式档位原文透传', () => {
  const p = { reasoning_effort: 'high' };
  assert.strictEqual(util.resolveReasoningEffort(p, 'medium'), 'high');
  assert.strictEqual(p.reasoning_effort, 'high');
});

check('思考强度：reasoning:{effort} 转成 reasoning_effort', () => {
  const p = { reasoning: { effort: 'low' } };
  assert.strictEqual(util.resolveReasoningEffort(p, 'medium'), 'low');
  assert.strictEqual(p.reasoning_effort, 'low');
  assert.strictEqual(p.reasoning, undefined, 'reasoning 对象必须删掉，否则上游可能拒绝');
});

check('思考强度：未指定时回落到默认档位（否则上游不返回思维链）', () => {
  const p = {};
  assert.strictEqual(util.resolveReasoningEffort(p, 'medium'), 'medium');
  assert.strictEqual(p.reasoning_effort, 'medium');
});

check('思考强度：默认档位留空则不添加该字段（保持上游默认行为）', () => {
  const p = {};
  assert.strictEqual(util.resolveReasoningEffort(p, ''), undefined);
  assert.strictEqual('reasoning_effort' in p, false);
});

check('思考强度：bool/对象等非字符串不再透传（原先 400 11101）', () => {
  const p1 = { reasoning_effort: true };
  util.resolveReasoningEffort(p1, 'medium');
  assert.strictEqual(typeof p1.reasoning_effort, 'string', '不得把 bool 发给上游');

  const p2 = { reasoning: { max_tokens: 2000 } };
  util.resolveReasoningEffort(p2, 'medium');
  assert.ok(
    typeof p2.reasoning_effort === 'string' || p2.reasoning_effort === undefined,
    'reasoning_effort 必须是字符串或缺席'
  );
  assert.strictEqual(p2.reasoning, undefined);
});

check('思考强度：显式关闭时不发该字段', () => {
  for (const payload of [
    { reasoning_effort: '' },
    { reasoning_effort: 'none' },
    { reasoning_effort: 'off' },
    { reasoning: false },
    { thinking: { type: 'disabled' } },
  ]) {
    const p = Object.assign({}, payload);
    assert.strictEqual(
      util.resolveReasoningEffort(p, 'medium'), undefined,
      `${JSON.stringify(payload)} 应视为关闭思考`
    );
    assert.strictEqual(p.reasoning_effort, undefined, '关闭时不应写入 reasoning_effort');
  }
});

check('思考强度：显式开启但无档位时用默认档', () => {
  const p = { thinking: { type: 'enabled' } };
  assert.strictEqual(util.resolveReasoningEffort(p, 'medium'), 'medium');
});

check('思考强度：数字档位映射到上游字符串', () => {
  assert.strictEqual(util.resolveReasoningEffort({ reasoning_effort: 1 }, 'medium'), 'minimal');
  assert.strictEqual(util.resolveReasoningEffort({ reasoning_effort: 5 }, 'medium'), 'high');
});

check('思考强度：清理后不留任何非法别名', () => {
  const p = { reasoning_effort: 'high', reasoning: { effort: 'low' }, thinking: { type: 'enabled' }, enableThinking: true };
  util.resolveReasoningEffort(p, 'medium');
  for (const k of ['reasoning', 'reasoningEffort', 'thinking', 'enableThinking']) {
    assert.strictEqual(k in p, false, `残留字段 ${k} 可能触发上游 400`);
  }
  assert.strictEqual(p.reasoning_effort, 'high');
});

/* ---------------- developer 角色归一化 ---------------- */

check('角色：developer 改写成 system（原先 400 11128）', () => {
  // 上游不认 OpenAI 的 developer 角色：system → 200，developer → 400 11128。
  // 推理模型下 DSH / pi-ai 会把系统提示词发成 developer，因此必须就地改写。
  const p = { messages: [{ role: 'developer', content: 't' }, { role: 'user', content: 'hi' }] };
  assert.strictEqual(util.normalizeDeveloperRole(p), 1);
  assert.strictEqual(p.messages[0].role, 'system', 'developer 必须改写成 system');
  assert.strictEqual(p.messages[0].content, 't', '内容必须原样保留');
  assert.strictEqual(p.messages[1].role, 'user', '其它角色不得受影响');
});

check('角色：无 developer 时不改动且返回 0', () => {
  const p = { messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }] };
  assert.strictEqual(util.normalizeDeveloperRole(p), 0);
  assert.strictEqual(p.messages[0].role, 'system');
  assert.strictEqual(p.messages[1].role, 'user');
});

check('角色：非对象/无 messages 时安全返回 0', () => {
  assert.strictEqual(util.normalizeDeveloperRole(null), 0);
  assert.strictEqual(util.normalizeDeveloperRole({}), 0);
  assert.strictEqual(util.normalizeDeveloperRole({ messages: 'oops' }), 0);
});

/* ---------------- CodeBuddy 渠道接入（端到端 preparePayload） ---------------- */

check('渠道：CodeBuddy preparePayload 同时归一化角色与思考强度', () => {
  const codebuddy = require(path.join(ROOT, 'core', 'providers', 'codebuddy', 'index.js'));
  const payload = {
    messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
    reasoning: { effort: 'low' },
  };
  codebuddy.preparePayload(payload);

  assert.strictEqual(payload.messages[0].role, 'system', 'developer 应降级为 system');
  assert.strictEqual(payload.reasoning, undefined, 'reasoning 对象必须清掉');
  assert.strictEqual(payload.reasoning_effort, 'low', '应写出 reasoning_effort 字符串');
  assert.strictEqual(typeof payload.reasoning_effort, 'string', '不得把 bool 发给上游');
});

check('渠道：CodeBuddy preparePayload 仍合并多条 system 消息', () => {
  const codebuddy = require(path.join(ROOT, 'core', 'providers', 'codebuddy', 'index.js'));
  const payload = {
    messages: [
      { role: 'developer', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'hi' },
    ],
  };
  codebuddy.preparePayload(payload);
  const systems = payload.messages.filter((m) => m.role === 'system');
  assert.strictEqual(systems.length, 1, '多条 system 必须合并成一条');
  assert.ok(systems[0].content.includes('A') && systems[0].content.includes('B'), '合并后应保留双方内容');
});

check('渠道：显式关闭思考时不添加 reasoning_effort', () => {
  const codebuddy = require(path.join(ROOT, 'core', 'providers', 'codebuddy', 'index.js'));
  const payload = { messages: [{ role: 'user', content: 'hi' }], reasoning: false };
  codebuddy.preparePayload(payload);
  assert.strictEqual('reasoning_effort' in payload, false, '显式关闭时不得写入 reasoning_effort');
});

/* ---------------- /v1/responses 路径必须把思考字段带到 chat ---------------- */

check('responses：reasoning:{effort} 被带到 chat 请求体', () => {
  // 否则 preparePayload 根本看不到客户端的思考意图，/v1/responses 的思考档位永远失效
  const { responsesToChatInput } = require(path.join(ROOT, 'core', 'responses.js'));
  const chat = responsesToChatInput({ model: 'm', input: 'hi', reasoning: { effort: 'low' } });
  assert.deepStrictEqual(chat.reasoning, { effort: 'low' }, 'reasoning 必须被带过去');
});

check('responses：reasoning_effort 别名同样被带到 chat 请求体', () => {
  const { responsesToChatInput } = require(path.join(ROOT, 'core', 'responses.js'));
  const chat = responsesToChatInput({ model: 'm', input: 'hi', reasoning_effort: 'high' });
  assert.strictEqual(chat.reasoning_effort, 'high');
});

check('responses：端到端 —— responses 输入的 reasoning 被归一化成 reasoning_effort 字符串', () => {
  const { responsesToChatInput } = require(path.join(ROOT, 'core', 'responses.js'));
  const codebuddy = require(path.join(ROOT, 'core', 'providers', 'codebuddy', 'index.js'));
  const chat = responsesToChatInput({ model: 'm', input: 'hi', reasoning: { effort: 'low' } });
  codebuddy.preparePayload(chat);
  assert.strictEqual(chat.reasoning, undefined, 'reasoning 对象必须被清掉');
  assert.strictEqual(chat.reasoning_effort, 'low', '应落成 reasoning_effort 字符串');
});

check('responses：客户端未提思考时不凭空添加字段', () => {
  const { responsesToChatInput } = require(path.join(ROOT, 'core', 'responses.js'));
  const chat = responsesToChatInput({ model: 'm', input: 'hi' });
  assert.strictEqual(chat.reasoning, undefined);
  assert.strictEqual('reasoning_effort' in chat, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
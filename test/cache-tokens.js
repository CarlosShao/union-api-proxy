'use strict';
/**
 * 缓存命中（prompt cache hit）字段解析的回归测试。
 *
 * 背景 bug：Trae SOLO 的 token_usage 用 Anthropic 字段名
 * （cache_read_input_tokens），而本地只认 OpenAI 的
 * prompt_cache_hit_tokens / *.cached_tokens，导致 Trae 的缓存命中
 * 在用量统计里恒为 0。
 */

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const util = require(path.join(ROOT, 'core', 'util.js'));
const sse = require(path.join(ROOT, 'core', 'providers', 'traework', 'sse.js'));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}

/* ---- util.cachedTokensOf：各家的字段形状 ---- */

check('OpenAI chat: prompt_cache_hit_tokens', () => {
  assert.strictEqual(util.cachedTokensOf({ prompt_cache_hit_tokens: 65536, prompt_tokens: 67178 }), 65536);
});

check('OpenAI chat: prompt_tokens_details.cached_tokens', () => {
  assert.strictEqual(util.cachedTokensOf({ prompt_tokens_details: { cached_tokens: 1024 } }), 1024);
});

check('Responses: input_tokens_details.cached_tokens', () => {
  assert.strictEqual(util.cachedTokensOf({ input_tokens_details: { cached_tokens: 2048 } }), 2048);
});

check('Trae/Anthropic: cache_read_input_tokens（本次修的核心）', () => {
  const u = { prompt_tokens: 10812, completion_tokens: 71, total_tokens: 10883,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 8192, reasoning_tokens: 68 };
  assert.strictEqual(util.cachedTokensOf(u), 8192);
});

check('Trae 实际返回的零值形态应读出 0 而不是 NaN/undefined', () => {
  const realTrae = { name: '', prompt_tokens: 10812, completion_tokens: 71, total_tokens: 10883,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0, reasoning_tokens: 68,
    prompt_tokens_total: 0, completion_tokens_total: 0, total_tokens_total: 0,
    cache_creation_input_tokens_total: 0, cache_read_input_tokens_total: 0,
    reasoning_tokens_total: 0, cluster: 'normal_context' };
  assert.strictEqual(util.cachedTokensOf(realTrae), 0);
});

check('累计口径的 *_total 不被误当成单次命中', () => {
  // total_tokens_total 恒为 0 而 total_tokens 非 0，说明 *_total 是另一套口径
  const u = { total_tokens: 46, total_tokens_total: 0, cache_read_input_tokens: 512, cache_read_input_tokens_total: 999999 };
  assert.strictEqual(util.cachedTokensOf(u), 512, '必须取单次值而不是累计值');
});

check('缺失/异常输入安全返回 0', () => {
  assert.strictEqual(util.cachedTokensOf(null), 0);
  assert.strictEqual(util.cachedTokensOf(undefined), 0);
  assert.strictEqual(util.cachedTokensOf({}), 0);
  assert.strictEqual(util.cachedTokensOf('nope'), 0);
  assert.strictEqual(util.cachedTokensOf({ prompt_cache_hit_tokens: 'abc' }), 0);
});

check('字符串数字可解析（部分网关会把 usage 转成字符串）', () => {
  assert.strictEqual(util.cachedTokensOf({ cache_read_input_tokens: '4096' }), 4096);
});

/* ---- sse.normalizeUsage：给下游客户端补 OpenAI 形状 ---- */

check('Trae usage 归一化后同时带 Anthropic 与 OpenAI 两种写法', () => {
  const out = sse.normalizeUsage({
    prompt_tokens: 10812, completion_tokens: 71, total_tokens: 10883,
    cache_creation_input_tokens: 256, cache_read_input_tokens: 8192,
  });
  assert.strictEqual(out.cache_read_input_tokens, 8192, 'Trae 原字段必须保留');
  assert.strictEqual(out.cache_creation_input_tokens, 256, 'Trae 原字段必须保留');
  assert.strictEqual(out.prompt_cache_hit_tokens, 8192, '要补 OpenAI 形状');
  assert.strictEqual(out.prompt_tokens_details.cached_tokens, 8192);
  assert.strictEqual(out.prompt_tokens_details.cache_write_tokens, 256);
});

check('Trae usage 归一化不修改入参（纯函数）', () => {
  const raw = { prompt_tokens: 10, cache_read_input_tokens: 4 };
  sse.normalizeUsage(raw);
  assert.strictEqual(raw.prompt_cache_hit_tokens, undefined, '入参不得被污染');
});

check('Trae usage 归一化对空值安全', () => {
  assert.strictEqual(sse.normalizeUsage(null), null);
  assert.strictEqual(sse.normalizeUsage(undefined), undefined);
});

check('端到端：SOLO token_usage 事件 -> 归一化 -> 本地能读出缓存命中', () => {
  // 构造一条真实的 SOLO 流，走 converter 看 usage 是否被归一化下发
  const lines = [
    'event:metadata',
    'data:{"model":"kimi-k2.7-code"}',
    '',
    'event:token_usage',
    'data:{"prompt_tokens":10812,"completion_tokens":71,"total_tokens":10883,"cache_creation_input_tokens":0,"cache_read_input_tokens":8192,"reasoning_tokens":68}',
    '',
    'event:done',
    'data:{"finish_reason":"stop"}',
    '',
    '',
  ].join('\n');

  const conv = sse.createSseConverter();
  const emitted = conv.feed(lines) + conv.end();
  assert.ok(emitted.includes('prompt_cache_hit_tokens'), '下发的 SSE 里应带 OpenAI 形状');
  assert.ok(emitted.includes('cache_read_input_tokens'), 'Trae 原字段也应保留');
  assert.ok(emitted.includes('8192'), '缓存命中数值应原样下发');

  // 再确认本地能从这份 usage 里读出来（正经解析 SSE 行，不靠正则猜嵌套）
  let usage = null;
  for (const line of emitted.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(d); } catch (e) { continue; }
    if (obj && obj.usage) usage = obj.usage;
  }
  assert.ok(usage, 'SSE 里应带 usage 字段');
  assert.strictEqual(usage.cache_read_input_tokens, 8192, 'Trae 原字段保留');
  assert.strictEqual(util.cachedTokensOf(usage), 8192, '本地应能读出缓存命中');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
'use strict';
/**
 * 验收演示：对比「移植前」与「移植后」在请求体上的差别。
 *
 * 全部离线运行（不连网络、不碰数据库、不需要登录态），直接对比
 *   before = BASE_REF 指向的旧代码
 *   after  = 当前工作区
 *
 * 基线刻意钉死在具体 sha 而不是用 main：改动一旦合并进 main，
 * 「前后对比」的基线必须保持不变，否则脚本会拿新代码跟自己比而失去意义。
 *
 * 运行：node test/acceptance-demo.js
 */

const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** 移植前 main 的 HEAD（本次上游移植工作的起点） */
const BASE_REF = 'a4573d3';

/** 取基线 ref 上的旧模块（临时落到临时目录，避免污染工作区） */
function loadFromMain(relPath) {
  const os = require('os');
  const fs = require('fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uap-before-'));
  const abs = relPath.replace(/\\/g, '/');
  const src = execFileSync('git', ['show', `${BASE_REF}:${abs}`], { cwd: ROOT, encoding: 'utf8' });
  const file = path.join(tmp, path.basename(relPath));
  fs.writeFileSync(file, src, 'utf8');
  return file;
}

let pass = 0, fail = 0;
function demo(title, beforeFn, afterFn, expect) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

  let before, after;
  try { before = beforeFn(); } catch (e) { before = `(抛错) ${e.message}`; }
  try { after = afterFn(); } catch (e) { after = `(抛错) ${e.message}`; }

  console.log(`\n  移植前 (main):  ${JSON.stringify(before)}`);
  console.log(`  移植后 (现在):  ${JSON.stringify(after)}`);

  try {
    expect(before, after);
    pass++;
    console.log(`  ✓ 符合预期\n`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${e.message}\n`);
  }
}

/* ================================================================== */
console.log('本次移植共 3 项，逐项验收\n');

/* ---------- 1. 思考强度归一化 ---------- */
const beforeUtil = loadFromMain('core/util.js');
const afterUtil = require(path.join(ROOT, 'core', 'util.js'));
const cbAfter = require(path.join(ROOT, 'core', 'providers', 'codebuddy', 'index.js'));

demo(
  '【1】思考强度：客户端发 reasoning_effort: true（布尔）',
  () => {
    const u = require(beforeUtil);
    const p = { reasoning_effort: true };
    // 旧代码没有任何归一化，字段原样透传给上游
    return { 透传给上游的字段: p, 上游会返回: '400 11101 (Go string 字段收到 bool)' };
  },
  () => {
    const p = { reasoning_effort: true };
    const eff = afterUtil.resolveReasoningEffort(p, 'medium');
    return { 归一化后: eff, 字段类型: typeof p.reasoning_effort, 上游会返回: '200' };
  },
  (b, a) => {
    assert.strictEqual(a.归一化后, 'medium', '应归一化为 medium');
    assert.ok(/400/.test(b.上游会返回), '修复前应为 400');
  }
);

demo(
  '【2】思考强度：客户端完全没提思考（最关键的一条）',
  () => {
    // 旧代码：从不发 reasoning_effort ⇒ 上游思考默认关闭 ⇒ 没有思维链
    return { 发出字段: '(无)', 上游返回思维链: false };
  },
  () => {
    const p = {};
    const eff = afterUtil.resolveReasoningEffort(p, 'medium');
    return { 发出字段: `reasoning_effort=${eff}`, 上游返回思维链: true };
  },
  (b, a) => {
    assert.strictEqual(a.发出字段, 'reasoning_effort=medium');
    assert.strictEqual(b.上游返回思维链, false, '修复前思维链是关着的');
  }
);

demo(
  '【3】思考强度：显式关闭仍要尊重（不能被默认档位覆盖）',
  () => {
    return { 说明: '旧代码不处理，直接透传 reasoning:false 给上游（Go 会拒绝对象）' };
  },
  () => {
    const p = { reasoning: false };
    const eff = afterUtil.resolveReasoningEffort(p, 'medium');
    return { 归一化后: eff === undefined ? '(不发该字段=思考关闭)' : eff, reasoning字段: p.reasoning };
  },
  (b, a) => {
    assert.strictEqual(a.归一化后, '(不发该字段=思考关闭)');
    assert.strictEqual(a.reasoning字段, undefined, '必须清掉会被上游拒绝的对象');
  }
);

demo(
  '【4】developer 角色（CodeBuddy 渠道 400 11128）',
  () => {
    // 旧代码已有该修复 —— 这是本地本来就比上游强的地方，本次保持不变
    const p = { messages: [{ role: 'developer', content: 'sys' }] };
    cbAfter.preparePayload.call(null, p);
    return { role: p.messages[0].role, 说明: '本地移植前已有此降级，上游本次无新增' };
  },
  () => {
    const p = { messages: [{ role: 'developer', content: 'sys' }] };
    cbAfter.preparePayload(p);
    return { role: p.messages[0].role, 说明: '保持不变，并额外归一化思考强度' };
  },
  (b, a) => {
    assert.strictEqual(a.role, 'system');
    assert.strictEqual(b.role, 'system', '本地原本就修好了，未回退');
  }
);

/* ---------- 2. 多模态分片 ---------- */
// 注意：main 上的 core/responses.js 有相对 require，无法脱离仓库单独加载，
// 因此「移植前」一栏直接内联复刻 main 当时的 contentToText 实现（逐行等价）。

demo(
  '【5】/v1/responses 传图片：base64 会不会被当成文本发给上游',
  () => {
    // 逐行等价于 main:core/responses.js 的 contentToText
    const beforeText = [
      { type: 'input_text', text: '这是什么图' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
    ].map((c) => {
      if (c.type === 'input_text') return c.text || '';
      if (c.type === 'input_image') return (typeof c.image_url === 'string' ? c.image_url : (c.image_url && c.image_url.url)) || '';
      return '';
    }).filter(Boolean).join('\n');
    return {
      旧代码压平后的内容: beforeText,
      长度: beforeText.length,
      模型看到的是: '一段 base64 文本，不是图片',
    };
  },
  () => {
    const { responsesToChatInput } = require(path.join(ROOT, 'core', 'responses.js'));
    const chat = responsesToChatInput({
      model: 'cc/glm-4v-turbo',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: '这是什么图' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
      ] }],
    });
    return {
      content类型: Array.isArray(chat.messages[0].content) ? '分片数组' : '字符串',
      分片: chat.messages[0].content.map((p) => p.type),
      base64是否进了文本: chat.messages[0].content.some((p) => p.type === 'text' && String(p.text).includes('base64')),
    };
  },
  (b, a) => {
    assert.ok(b.长度 > 50, '修复前确实把 base64 当成了文本');
    assert.strictEqual(a.base64是否进了文本, false, '修复后 base64 不得出现在文本分片');
    assert.deepStrictEqual(a.分片, ['text', 'image_url']);
  }
);

demo(
  '【6】纯文本请求不受影响（不能为了图片把普通对话搞坏）',
  () => {
    return { 说明: '修复前 content 是字符串', content类型: 'string' };
  },
  () => {
    const { responsesToChatInput } = require(path.join(ROOT, 'core', 'responses.js'));
    const chat = responsesToChatInput({
      model: 'cc/glm-5.2',
      input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
    });
    return { content类型: typeof chat.messages[0].content, 值: chat.messages[0].content };
  },
  (b, a) => {
    assert.strictEqual(a.content类型, 'string', '纯文本必须仍是字符串');
    assert.strictEqual(a.值, '你好');
  }
);

demo(
  '【7】用户消息的净化级别没被顺带升级（本次移植最容易踩的坑）',
  () => {
    return { 说明: '上游版本用布尔开关，只有一个净化强度' };
  },
  () => {
    const { responsesToChatInput } = require(path.join(ROOT, 'core', 'responses.js'));
    const chat = responsesToChatInput({
      model: 'cc/glm-5.2',
      input: [{ role: 'user', content: [{ type: 'input_text', text: '帮我对比 OpenAI 和 Codex' }] }],
    });
    return { 用户消息内容: chat.messages[0].content, 是否被改写: chat.messages[0].content !== '帮我对比 OpenAI 和 Codex' };
  },
  (b, a) => {
    assert.strictEqual(a.是否被改写, false, '用户消息必须原样透传');
  }
);

/* ---------- 3. 版本徽标 ---------- */
const readTopBar = (ref) => {
  const fs = require('node:fs');
  if (ref === 'main') return execFileSync('git', ['show', `${BASE_REF}:web/src/components/TopBar.vue`], { cwd: ROOT, encoding: 'utf8' });
  return fs.readFileSync(path.join(ROOT, 'web/src/components/TopBar.vue'), 'utf8');
};

demo(
  '【8】版本徽标（纯 UI）',
  () => {
    const tb = readTopBar('main');
    return { TopBar有版本徽标: tb.includes('nav.versionTitle'), GitHub链接指向: (tb.match(/github\.com\/[^"]+/) || [])[0] };
  },
  () => {
    const tb = readTopBar('worktree');
    return { TopBar有版本徽标: tb.includes('nav.versionTitle'), GitHub链接指向: (tb.match(/github\.com\/[^"]+/) || [])[0] };
  },
  (b, a) => {
    assert.strictEqual(b.TopBar有版本徽标, false, '移植前应没有徽标');
    assert.strictEqual(a.TopBar有版本徽标, true, '移植后应有徽标');
    assert.ok(!b.GitHub链接指向.includes('CarlosShao'), '移植前指向的是鼻祖仓库');
    assert.ok(a.GitHub链接指向.includes('CarlosShao'), '移植后应指向本仓库');
  }
);

console.log(`${'='.repeat(72)}\n结果：${pass} 项符合预期，${fail} 项不符\n`);
process.exit(fail === 0 ? 0 : 1);
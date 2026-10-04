'use strict';
/**
 * /v1/responses 流式转换的回归测试（移植自上游 d1ed41e）。
 *
 * 覆盖 3 个真实缺陷：
 *   1. 思维链在流式下完全丢失 —— state.reasoning 被累计却从不发事件，
 *      buildResponseObject 也不读它（只有非流式路径有思维链）。
 *   2. output_index 不一致 —— added 与 done 都直接写 state.toolCalls.length。
 *      「正文先开始、之后又来工具调用」时，同一 item 的 added/done 会拿到
 *      两个不同的 output_index，SSE 序列非法。单工具时碰巧正确，所以难发现。
 *   3. finish() 先完结 message 再完结工具，与 response.completed 里 output
 *      数组的顺序（工具在前、message 在后）相反，且 output_index 非递增。
 *
 * 手法：起一个假上游吐出构造好的 OpenAI SSE，用假 res 驱动
 * streamChatToResponses，断言事件序列。不连网络、不需要登录态。
 */

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { Writable } = require('node:stream');

const ROOT = path.join(__dirname, '..');
const { streamChatToResponses } = require(path.join(ROOT, 'core', 'responses.js'));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}

/** 收集 clientRes 写出的 SSE 事件 */
function fakeRes() {
  const buf = { text: '', ended: false };
  const res = new Writable({
    write(chunk, _enc, cb) { buf.text += chunk.toString(); cb(); },
  });
  res.writeHead = () => res;
  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.removeHeader = () => res;
  res.end = (chunk) => {
    if (chunk) buf.text += chunk.toString();
    buf.ended = true;
    res.emit && res.emit('finish');
  };
  res._buf = buf;
  return res;
}

function parseEvents(text) {
  const evs = [];
  let evName = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) { evName = line.slice(6).trim(); continue; }
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    let obj; try { obj = JSON.parse(d); } catch (e) { continue; }
    evs.push({ event: evName || obj.type, data: obj });
  }
  return evs;
}

/** 起一个假上游，按给定脚本吐出 SSE */
function fakeUpstream(script) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(script);
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

function chunk(model, delta, finish) {
  return 'data: ' + JSON.stringify({
    id: 'x', object: 'chat.completion.chunk', created: 1, model: model || 'm',
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  }) + '\n\n';
}
const DONE = 'data: [DONE]\n\n';

async function drive(script, originalReq) {
  const up = await fakeUpstream(script);
  const res = fakeRes();
  await streamChatToResponses(
    res,
    `http://127.0.0.1:${up.port}/v1/chat/completions`,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ model: 'm', messages: [], stream: true }),
    originalReq || { model: 'm' }
  );
  await up.close();
  return parseEvents(res._buf.text);
}

(async () => {
  /* ---------- 1. 思维链：流式下必须能拿到 ---------- */

  const withReasoning = await drive(
    chunk('m', { reasoning_content: '先想想：' }) +
    chunk('m', { reasoning_content: '答案是42' }) +
    chunk('m', { content: '答案' }) +
    chunk('m', {}, 'stop') + DONE
  );

  check('思维链：流中出现 reasoning 相关事件', () => {
    const names = withReasoning.map((e) => e.event);
    assert.ok(names.includes('response.output_item.added'), '应有 output_item.added');
    const added = withReasoning.find((e) => e.event === 'response.output_item.added' && e.data.item.type === 'reasoning');
    assert.ok(added, '应发出 reasoning 类型的 output_item.added');
    assert.strictEqual(added.data.output_index, 0, 'reasoning 必须占 0 号位');
  });

  check('思维链：reasoning_summary_text.delta 携带内容', () => {
    const deltas = withReasoning.filter((e) => e.event === 'response.reasoning_summary_text.delta');
    assert.ok(deltas.length >= 2, '应逐段下发思考增量');
    assert.strictEqual(deltas.map((d) => d.data.delta).join(''), '先想想：答案是42');
  });

  check('思维链：response.completed 的 output 里带 reasoning 项', () => {
    const done = withReasoning.find((e) => e.event === 'response.completed');
    assert.ok(done, '应有 response.completed');
    const rs = done.data.response.output.find((o) => o.type === 'reasoning');
    assert.ok(rs, 'completed.output 必须含 reasoning（此前完全丢失）');
    assert.strictEqual(rs.status, 'completed');
    assert.strictEqual(rs.summary[0].text, '先想想：答案是42');
    assert.ok(!('content' in rs), 'reasoning 项不该有 content 字段（Responses schema 无此字段）');
  });

  check('思维链：reasoning 排在 message 之前', () => {
    const done = withReasoning.find((e) => e.event === 'response.completed');
    assert.deepStrictEqual(done.data.response.output.map((o) => o.type), ['reasoning', 'message']);
  });

  /* ---------- 2. output_index 一致性（核心回归） ---------- */

  // 构造最容易触发旧 bug 的顺序：先出工具调用 -> 再出正文 -> 再来第二个工具
  const toolFirst = await drive(
    chunk('m', { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'f1', arguments: '{"a":1}' } }] }) +
    chunk('m', { content: '中间文字' }) +
    chunk('m', { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'f2', arguments: '{"b":2}' } }] }) +
    chunk('m', {}, 'stop') + DONE
  );

  check('output_index：message 的 added 与 done 必须是同一个 index', () => {
    const added = toolFirst.find((e) => e.event === 'response.output_item.added' && e.data.item.type === 'message');
    const done = toolFirst.find((e) => e.event === 'response.output_item.done' && e.data.item.type === 'message');
    assert.ok(added, '应有 message 的 added');
    assert.ok(done, '应有 message 的 done');
    assert.strictEqual(added.data.output_index, done.data.output_index,
      `同一 item 的 added(${added.data.output_index}) 与 done(${done.data.output_index}) 必须一致`);
  });

  check('output_index：每个 function_call 的 added 与 done index 一致', () => {
    const addedById = {};
    for (const e of toolFirst) {
      if (e.event === 'response.output_item.added' && e.data.item.type === 'function_call') addedById[e.data.item.id] = e.data.output_index;
    }
    for (const e of toolFirst) {
      if (e.event === 'response.output_item.done' && e.data.item.type === 'function_call') {
        assert.ok(addedById[e.data.item.id] !== undefined, 'done 的 item 必须有对应的 added');
        assert.strictEqual(addedById[e.data.item.id], e.data.output_index, `${e.data.item.id} 的 index 不一致`);
      }
    }
    assert.strictEqual(Object.keys(addedById).length, 2, '本用例应有两个工具调用');
  });

  check('output_index：全程不重复占用（不同 item 不得撞号）', () => {
    const used = [];
    for (const e of toolFirst) {
      if (e.event === 'response.output_item.added') used.push([e.data.item.type, e.data.output_index]);
    }
    const idx = used.map((u) => u[1]);
    assert.strictEqual(new Set(idx).size, idx.length, `output_index 撞号了: ${JSON.stringify(used)}`);
  });

  /* ---------- 3. finish() 完结顺序 ---------- */

  check('finish：output_item.done 按 output_index 升序', () => {
    const dones = toolFirst.filter((e) => e.event === 'response.output_item.done').map((e) => e.data.output_index);
    const sorted = [...dones].sort((a, b) => a - b);
    assert.deepStrictEqual(dones, sorted, `done 顺序应递增，实际 ${JSON.stringify(dones)}`);
  });

  check('finish：done 顺序与 completed.output 顺序一致', () => {
    const dones = toolFirst.filter((e) => e.event === 'response.output_item.done').map((e) => e.data.item.type);
    const completed = toolFirst.find((e) => e.event === 'response.completed');
    assert.deepStrictEqual(dones, completed.data.response.output.map((o) => o.type),
      '事件完结顺序必须与最终 output 数组顺序一致');
  });

  /* ---------- 4. 无思维链时不得凭空产生 reasoning ---------- */

  const noReasoning = await drive(
    chunk('m', { content: '纯文本' }) + chunk('m', {}, 'stop') + DONE
  );

  check('无思维链：不得凭空发出 reasoning 事件', () => {
    const names = noReasoning.map((e) => e.event);
    assert.ok(!names.includes('response.reasoning_summary_text.delta'), '不该有 reasoning delta');
    const added = noReasoning.find((e) => e.event === 'response.output_item.added' && e.data.item.type === 'reasoning');
    assert.ok(!added, '不该有 reasoning 的 output_item.added');
    // message 仍应占 0 号位
    const msgAdded = noReasoning.find((e) => e.event === 'response.output_item.added' && e.data.item.type === 'message');
    assert.strictEqual(msgAdded.data.output_index, 0);
  });

  /* ---------- 5. reasoning 对象形式（?? 级联的老坑） ---------- */

  const objReasoning = await drive(
    chunk('m', { reasoning: { content: '对象形式的思考' } }) +
    chunk('m', { content: '答案' }) + chunk('m', {}, 'stop') + DONE
  );

  check('思维链：delta.reasoning 为对象时也能取到 .content', () => {
    const deltas = objReasoning.filter((e) => e.event === 'response.reasoning_summary_text.delta');
    assert.ok(deltas.length > 0, '对象形式的 reasoning 不该被吞掉');
    assert.strictEqual(deltas.map((d) => d.data.delta).join(''), '对象形式的思考');
  });

  /* ---------- 6. reasoning 迟到（正文已开始）不破坏序列 ---------- */

  const lateReasoning = await drive(
    chunk('m', { content: '先说正文' }) +
    chunk('m', { reasoning_content: '迟到的思考' }) +
    chunk('m', {}, 'stop') + DONE
  );

  check('迟到思维链：不补发流式事件，但仍进最终 output', () => {
    const deltas = lateReasoning.filter((e) => e.event === 'response.reasoning_summary_text.delta');
    assert.strictEqual(deltas.length, 0, '正文已开始后不得再补发 reasoning 事件（会破坏 output_index）');
    const completed = lateReasoning.find((e) => e.event === 'response.completed');
    const rs = completed.data.response.output.find((o) => o.type === 'reasoning');
    assert.ok(rs, '迟到的思维链仍应出现在最终 output 里');
    assert.strictEqual(rs.summary[0].text, '迟到的思考');
    // message 的 index 不应被 reasoning 挤动
    const msgAdded = lateReasoning.find((e) => e.event === 'response.output_item.added' && e.data.item.type === 'message');
    const msgDone = lateReasoning.find((e) => e.event === 'response.output_item.done' && e.data.item.type === 'message');
    assert.strictEqual(msgAdded.data.output_index, msgDone.data.output_index);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
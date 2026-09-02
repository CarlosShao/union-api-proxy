'use strict';

/**
 * 统一日志入口：同时输出到控制台，并按系统配置异步批量写入 SQLite。
 * 用法：log('info', 'proxy', 'chat 完成', { model, ... })
 *
 * 日志写入通过 store.addLog() 的缓冲机制异步批量处理，
 * 不会阻塞事件循环。
 */

const store = require('./store');

function log(level, category, message, meta) {
  const line = `[${new Date().toISOString()}] [${String(level).toUpperCase()}] [${category}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  // 异步批量写入：store.addLog 会缓冲日志，定期批量刷入 SQLite
  store.addLog(level, category, message, meta);
}

function requestSummary(payload, extra) {
  const out = { ...(extra || {}) };
  if (payload && typeof payload === 'object') {
    if (payload.stream != null) out.stream = !!payload.stream;
    if (Array.isArray(payload.messages)) out.messages = payload.messages.length;
    if (Array.isArray(payload.tools)) out.tools = payload.tools.length;
    if (payload.input != null) {
      out.input = Array.isArray(payload.input) ? payload.input.length : typeof payload.input;
    }
  }
  return out;
}

module.exports = { log, requestSummary };

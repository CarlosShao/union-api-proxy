'use strict';

/**
 * 渠道动态模型缓存。
 *
 * Trae 的可用模型随账号权益变化，静态表只是兜底。`/v1/models` 与 `/api/models`
 * 需要同步返回，故此处做一层带 TTL 的缓存：首次请求异步拉取，失败时回退静态表。
 * 每个渠道各自缓存（账号不同、权益不同，取「有账号渠道」的并集）。
 */

const logger = require('../logger');
const sessionMod = require('../session');
const providers = require('./all');

const TTL_MS = 60 * 60 * 1000;      // 成功结果缓存 1 小时
const FAIL_COOLDOWN_MS = 5 * 60 * 1000; // 失败后 5 分钟内不重试，避免拖慢请求

/** kind -> { models: ModelInfo[], at: number, failedAt: number } */
const cache = new Map();
const inflight = new Map();

/** 同步读取当前缓存的动态模型（未就绪返回 null） */
function getCached(kind) {
  const c = cache.get(kind);
  if (!c || !c.models) return null;
  if (Date.now() - c.at > TTL_MS) return null;
  return c.models;
}

/**
 * 触发一次后台刷新（不阻塞调用方）。
 * 若正在刷新或处于失败冷却期则跳过。
 */
function refresh(kind) {
  const c = cache.get(kind) || {};
  if (inflight.has(kind)) return;
  if (c.failedAt && Date.now() - c.failedAt < FAIL_COOLDOWN_MS) return;
  if (c.models && Date.now() - c.at < TTL_MS) return;

  const provider = providers.getProvider(kind);
  if (!provider || typeof provider.listModels !== 'function') return;

  const acct = sessionMod.listAccounts(kind).find((a) => a.auth && a.auth.accessToken);
  if (!acct) return;

  inflight.set(kind, true);
  Promise.resolve()
    .then(() => provider.listModels(acct))
    .then((list) => {
      if (Array.isArray(list) && list.length) {
        cache.set(kind, { models: list, at: Date.now(), failedAt: 0 });
        logger.log('debug', 'system', `[${providers.labelOf(kind)}] 动态模型已缓存: ${list.length} 个`);
      } else {
        cache.set(kind, { models: null, at: 0, failedAt: Date.now() });
      }
    })
    .catch((e) => {
      cache.set(kind, { models: (cache.get(kind) || {}).models || null, at: 0, failedAt: Date.now() });
      logger.log('debug', 'system', `[${providers.labelOf(kind)}] 动态模型拉取失败（回退静态表）: ${e.message}`);
    })
    .finally(() => { inflight.delete(kind); });
}

/**
 * 构造 models.allModels 需要的 extra 映射：{ codebuddy: [...], traework: [...] }。
 * 优先用缓存的动态列表，缺失则用静态兜底；同时触发后台刷新以便下次拿到真实列表。
 *
 * 动态列表会覆盖同 key 的静态条目（allModels 里 extra 后写入），
 * 因此 ModelCatalog 只需维护合理的兜底值即可。
 * onlyLoggedIn=true 时跳过没有账号的渠道。
 */
function extraModelsForAllProviders({ onlyLoggedIn = false } = {}) {
  const out = {};
  for (const p of providers.listProviders()) {
    if (onlyLoggedIn && !sessionMod.isLoggedIn(p.kind)) continue;
    refresh(p.kind);
    const dyn = getCached(p.kind);
    const list = (dyn && dyn.length) ? dyn : (typeof p.staticModels === 'function' ? p.staticModels() : []);
    if (list && list.length) out[p.kind] = list;
  }
  return out;
}

module.exports = { getCached, refresh, extraModelsForAllProviders };

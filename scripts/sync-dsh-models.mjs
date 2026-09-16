#!/usr/bin/env node
/**
 * 把 union-api 代理的模型列表同步进 DSH 的 settings.yaml。
 *
 * 背景（为什么需要这个脚本）
 * --------------------------
 * DSH 的「获取可用模型」只认 4 个字段：id / name / contextWindow / maxTokens
 * （见 dsh-llm-pi-ai 的 readListing）。**图片模态(input) 与 推理等级(reasoningEfforts)
 * 无法从 /v1/models 探测**，必须在 settings.yaml 里逐模型声明——这是 DSH 的设计，
 * 官方文档明确写了「推理等级刻意不在可编辑字段之列」。
 *
 * 因此本脚本：从代理拉模型 -> 按能力策略补上 input / reasoningEfforts -> 增量改写
 * settings.yaml 里该 provider 的 models 数组（只替换本脚本管辖的前缀，其它条目原样保留）。
 *
 * 用法
 * ----
 *   node scripts/sync-dsh-models.mjs            # 写入（自动备份）
 *   node scripts/sync-dsh-models.mjs --dry-run  # 只打印将要写入的内容
 *
 * 环境变量
 * --------
 *   UNION_BASE_URL  代理地址，默认 http://127.0.0.1:3800
 *   UNION_API_KEY   代理访问密钥；不设则尝试从 /api/keys 读取（管理鉴权关闭时可用）
 *   DSH_SETTINGS    settings.yaml 路径，默认 ~/.dsh/settings.yaml
 *   DSH_PROVIDER    目标 provider 路由名，默认 union-api
 *   SYNC_PREFIX     只接管该前缀的模型，默认 cmdc/（其它条目不动）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = (process.env.UNION_BASE_URL || 'http://127.0.0.1:3800').replace(/\/+$/, '');
const SETTINGS = process.env.DSH_SETTINGS || path.join(os.homedir(), '.dsh', 'settings.yaml');
const PROVIDER = process.env.DSH_PROVIDER || 'union-api';
const PREFIX = process.env.SYNC_PREFIX || 'cmdc/';
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * 能力策略
 * --------
 * 图片：只给「明确多模态」的家族开，避免给纯文本模型误开——
 *   DSH 对超范围声明的后果很重：附件会先落到会话里，再被上游中途拒绝，
 *   导致该会话反复重试同一个不可能成功的请求（官方文档原话）。
 *   宁可少开（会当面拒绝并点名模型），也不要多开。
 * 发现某个模型确实支持图片，就往 VISION_PATTERNS 加一条正则。
 */
const VISION_PATTERNS = [
  /^cmdc\/claude-/i,          // Claude 4.5+/5 全线多模态
  /^cmdc\/google\/gemini/i,   // Gemini 全线多模态
  /^cmdc\/gpt-/i,             // GPT-5 家族多模态
  /^cmdc\/xai\/grok/i,        // Grok 4.x 多模态
  /vision/i,                  // 显式 vision 变体（如 deepseek-v4-flash-vision-exp）
  /-vl(\b|-)/i,               // Qwen-VL 之类
  /omni/i,
];

/** 推理等级阶梯：键=DSH 展示的等级，值=发给上游的线格式（off 为 null 表示「支持但不发参数」） */
const REASONING_LADDER = { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/**
 * 明确不支持推理的模型（按 id 匹配则写 reasoningEfforts: false）。
 * 默认空：清单里基本都是推理模型；发现某个模型带推理参数会报错，就加一条正则到这里。
 */
const NO_REASONING_PATTERNS = [
  // /^cmdc\/meituan\/LongCat/i,
];

function isVision(id) { return VISION_PATTERNS.some((re) => re.test(id)); }
function isNonReasoning(id) { return NO_REASONING_PATTERNS.some((re) => re.test(id)); }

/** YAML 双引号标量：转义反斜杠与双引号，避免名字里的特殊字符破坏结构 */
function yq(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

async function resolveApiKey() {
  if (process.env.UNION_API_KEY) return process.env.UNION_API_KEY;
  try {
    const r = await fetch(`${BASE_URL}/api/keys`);
    if (!r.ok) return '';
    const j = await r.json();
    return (j.keys && j.keys[0] && j.keys[0].key) || '';
  } catch { return ''; }
}

async function fetchModels(apiKey) {
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const r = await fetch(`${BASE_URL}/v1/models`, { headers });
  if (!r.ok) throw new Error(`拉取模型失败: HTTP ${r.status} ${await r.text().catch(() => '')}`);
  const j = await r.json();
  const list = Array.isArray(j && j.data) ? j.data : [];
  return list
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: Number(m.context_length) || 0,
      maxTokens: Number(m.max_output_tokens) || 0,
    }))
    .filter((m) => m.id && m.id.startsWith(PREFIX))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 生成一个模型条目的 YAML 文本（缩进 8 空格，与现有文件一致） */
function renderEntry(m) {
  const lines = [];
  lines.push(`        - id: ${yq(m.id)}`);
  if (m.name && m.name !== m.id) lines.push(`          name: ${yq(m.name)}`);
  if (m.contextWindow > 0) lines.push(`          contextWindow: ${m.contextWindow}`);
  if (m.maxTokens > 0) lines.push(`          maxTokens: ${m.maxTokens}`);
  if (isVision(m.id)) {
    lines.push('          input:');
    lines.push('            - text');
    lines.push('            - image');
  }
  if (isNonReasoning(m.id)) {
    lines.push('          reasoningEfforts: false');
  } else {
    lines.push('          reasoningEfforts:');
    for (const [level, wire] of Object.entries(REASONING_LADDER)) {
      lines.push(`            ${level}: ${wire === null ? 'null' : wire}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * 在 settings.yaml 里定位 provider 的 models 数组，返回 { start, end }（行号，左闭右开）。
 * start = `models:` 那一行之后的第一行；end = 下一个缩进 <= 6 的非空行。
 */
function locateModelsBlock(lines) {
  const provRe = new RegExp(`^ {4}${PROVIDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`);
  let provIdx = lines.findIndex((l) => provRe.test(l));
  if (provIdx < 0) throw new Error(`settings.yaml 里没找到 provider「${PROVIDER}」`);
  let modelsIdx = -1;
  for (let i = provIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.match(/^ */)[0].length;
    if (indent <= 4) break;             // 到了下一个 provider / 顶层键
    if (/^ {6}models:\s*$/.test(line)) { modelsIdx = i; break; }
  }
  if (modelsIdx < 0) throw new Error(`provider「${PROVIDER}」下没有 models: 块（请先手工建一个空 models:）`);
  let end = lines.length;
  for (let i = modelsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.match(/^ */)[0].length;
    if (indent <= 6) { end = i; break; }
  }
  return { start: modelsIdx + 1, end };
}

/** 把 models 块切成条目块：每个条目以 8 空格 `- id:` 开头 */
function splitEntries(blockLines) {
  const entries = [];
  let cur = null;
  for (const line of blockLines) {
    if (/^ {8}- /.test(line)) {
      if (cur) entries.push(cur);
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

function entryId(entryLines) {
  const first = entryLines[0] || '';
  const m = first.match(/^ {8}- id:\s*(.+?)\s*$/);
  if (!m) return '';
  return m[1].replace(/^["']|["']$/g, '');
}

async function main() {
  const apiKey = await resolveApiKey();
  const models = await fetchModels(apiKey);
  if (!models.length) throw new Error(`代理没有返回任何 ${PREFIX} 开头的模型`);

  const raw = fs.readFileSync(SETTINGS, 'utf8');
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);

  const { start, end } = locateModelsBlock(lines);
  const entries = splitEntries(lines.slice(start, end));

  // 只接管 PREFIX 开头的条目，其它（cc/、tc/ 等你手调的）原样保留
  const kept = entries.filter((e) => !entryId(e).startsWith(PREFIX));
  const managedBefore = entries.length - kept.length;

  const generated = models.map((m) => renderEntry(m).replace(/\n$/, '').split('\n'));

  // 保留块在前、生成的块按 id 排序在后
  const newBlock = [...kept, ...generated].map((e) => e.join(eol)).join(eol).split(eol);

  const out = [...lines.slice(0, start), ...newBlock, ...lines.slice(end)];
  const text = (hadBom ? '\uFEFF' : '') + out.join(eol);

  const visionCount = models.filter((m) => isVision(m.id)).length;
  console.log(`代理模型（${PREFIX}*）: ${models.length} 个`);
  console.log(`  多模态(开图片): ${visionCount} 个`);
  console.log(`  推理等级: ${models.length - models.filter((m) => isNonReasoning(m.id)).length} 个带阶梯，${models.filter((m) => isNonReasoning(m.id)).length} 个关闭`);
  console.log(`settings: ${SETTINGS}`);
  console.log(`保留的手工条目: ${kept.length} 个（其中本次替换掉的旧 ${PREFIX}* 条目: ${managedBefore} 个）`);

  if (DRY_RUN) {
    console.log('\n--- dry-run，未写入。生成的块预览 ---\n');
    console.log(generated.slice(0, 2).map((e) => e.join('\n')).join('\n'));
    console.log('...');
    return;
  }

  const backup = `${SETTINGS}.bak-sync-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SETTINGS, backup);
  fs.writeFileSync(SETTINGS, text, 'utf8');
  console.log(`\n已写入。备份: ${backup}`);
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });

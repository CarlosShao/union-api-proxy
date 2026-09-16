<script setup>
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRequest } from 'alova/client';
import { api } from '@/api';

const { t } = useI18n();

const { data: status, loading, send: reload } = useRequest(() => api.status());
const { data: modelData, send: reloadModels } = useRequest(() => api.listModels());

const models = computed(() => modelData.value?.models || status.value?.models || []);

// 可用渠道（来自 /api/status，用于新增自定义模型时选择归属）
const providers = computed(() => status.value?.providers || [{ kind: 'codebuddy', label: 'CodeBuddy' }]);

// 按渠道分组展示：两家都有 glm-5.2 这类同名模型，必须分组才不混淆。
// 自定义 OpenAI 兼容 API（openai-custom）一个代理可配多个 endpoint，模型可能重名，
// 故按 endpoint 维度二次拆组（组标题带 endpoint 名称与模型前缀）。
const grouped = computed(() => {
  const map = new Map();
  for (const m of models.value) {
    const p = m.provider || 'codebuddy';
    // openai-custom 按 endpoint 拆分（单 endpoint 时空 sub 仍独立成组）
    const sub = p === 'openai-custom' ? (m.endpointId || m.prefix || '') : '';
    const key = p + '\u0000' + sub;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  // 保持 providers 声明顺序，未声明的渠道追加在后
  const order = providers.value.map((p) => p.kind);
  return [...map.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0].split('\u0000')[0]); const ib = order.indexOf(b[0].split('\u0000')[0]);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    })
    .map(([key, list]) => {
      const [kind, sub] = key.split('\u0000');
      const first = list[0] || {};
      const label = providers.value.find((p) => p.kind === kind)?.label || kind;
      // openai-custom 的组标题 = endpoint 名称 + 前缀（如 "OpenRouter · oc/"）
      const subtitle = kind === 'openai-custom' && first.endpointName
        ? `${first.endpointName} · ${first.prefix || 'oc'}/`
        : '';
      return { kind, sub, label, subtitle, models: list };
    });
});

/** 模型对外 id（后端返回 key；兜底同样按「渠道/模型」拼接，与后端规则保持一致） */
function modelId(m) {
  if (m.key) return m.key;
  return (m.provider || 'codebuddy') + '/' + m.id;
}

/**
 * 自定义 OpenAI 兼容 endpoint 的模型来自「自定义 API」页管理（增删/启停在那一页），
 * 故在「模型」菜单里只读展示，禁用隐藏/编辑/删除（避免与 endpoint 管理脱节）。
 */
function canManage(m) {
  return m.source !== 'custom-api' && m.builtin === false;
}

function sourceLabel(m) {
  if (m.source === 'custom-api') return t('models.customApi');
  return m.builtin === false ? t('models.custom') : t('models.builtin');
}

function sourceClass(m) {
  if (m.source === 'custom-api') return 'badge-custom-api';
  return m.builtin === false ? 'badge-custom' : 'badge-neutral';
}

/* ---- 新增 / 编辑模型弹窗 ---- */
const showForm = ref(false);
const editingId = ref(null);
const saving = ref(false);
const formError = ref('');
const form = reactive({
  id: '',
  provider: 'codebuddy',
  name: '',
  maxInputTokens: 0,
  maxOutputTokens: 0,
  tools: true,
  vision: false,
  reasoning: false,
  region: 'cn',
});

function openAdd() {
  editingId.value = null;
  formError.value = '';
  Object.assign(form, {
    id: '', provider: providers.value[0]?.kind || 'codebuddy', name: '',
    maxInputTokens: 0, maxOutputTokens: 0,
    tools: true, vision: false, reasoning: false, region: 'cn',
  });
  showForm.value = true;
}

function openEdit(m) {
  editingId.value = modelId(m);
  formError.value = '';
  Object.assign(form, {
    id: m.id, provider: m.provider || 'codebuddy', name: m.name,
    maxInputTokens: m.maxInputTokens || 0,
    maxOutputTokens: m.maxOutputTokens || 0,
    tools: !!m.tools, vision: !!m.vision, reasoning: !!m.reasoning,
    region: m.region || 'cn',
  });
  showForm.value = true;
}

async function submitForm() {
  saving.value = true;
  formError.value = '';
  try {
    if (editingId.value) {
      // 编辑 = 删除旧记录（provider+id 为主键）后按当前表单新增
      await api.deleteModel(editingId.value);
    }
    await api.addModel({ ...form });
    showForm.value = false;
    await reloadModels();
    await reload();
  } catch (e) {
    formError.value = e.message || String(e);
  } finally {
    saving.value = false;
  }
}

async function remove(m) {
  const id = modelId(m);
  if (!confirm(`${t('models.confirmDelete')} "${id}"？`)) return;
  try {
    await api.deleteModel(id);
    await reloadModels();
    await reload();
  } catch (e) {
    alert(`${t('models.deleteError')}: ${e.message}`);
  }
}

const togglingHidden = ref(new Set());
async function toggleHidden(m) {
  const id = modelId(m);
  togglingHidden.value = new Set([...togglingHidden.value, id]);
  try {
    await api.setModelHidden(id, !m.hidden);
    await reloadModels();
    await reload();
  } catch (e) {
    alert(t('models.hideError') + ': ' + e.message);
    await reloadModels();
  } finally {
    const s = new Set(togglingHidden.value);
    s.delete(id);
    togglingHidden.value = s;
  }
}
</script>

<template>
  <div>
    <div class="card">
      <div class="head-row">
        <h2 class="card-title">
          {{ t('models.title') }}
          <span class="sub">{{ t('overview.modelCount', { count: models.length }) }}</span>
        </h2>
        <button class="btn btn-primary" @click="openAdd">+ {{ t('models.add') }}</button>
      </div>

      <div v-if="loading" class="muted">{{ t('common.loading') }}</div>
      <div v-else-if="!models.length" class="empty"><span class="icon">◈</span>{{ t('common.empty') }}</div>

      <!-- 按渠道分组：同渠道内是同一上游的模型，跨渠道可能重名（如 glm-5.2）；
           自定义 OpenAI 兼容 endpoint 再按 endpoint 维度拆组 -->
      <div v-else class="groups">
        <section v-for="g in grouped" :key="g.kind + (g.sub || '')" class="group">
          <h3 class="group-title">
            <span class="channel-chip">{{ g.label }}</span>
            <span v-if="g.subtitle" class="channel-sub">{{ g.subtitle }}</span>
            <span class="group-sub">{{ t('overview.modelCount', { count: g.models.length }) }}</span>
          </h3>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>{{ t('models.colId') }}</th>
                  <th>{{ t('models.colName') }}</th>
                  <th>{{ t('models.colCtx') }}</th>
                  <th>{{ t('models.colOutput') }}</th>
                  <th>{{ t('models.colCapabilities') }}</th>
                  <th>{{ t('models.colSource') }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in g.models" :key="modelId(m)">
                  <td>
                    <code>{{ modelId(m) }}</code>
                    <span v-if="m.isDefault" class="badge badge-primary">{{ t('models.default') }}</span>
                    <span class="badge" :class="m.region === 'intl' ? 'badge-warning' : 'badge-neutral'">
                      {{ m.region === 'intl' ? t('models.intl') : t('models.cn') }}
                    </span>
                    <span v-if="m.hidden" class="badge badge-warning">{{ t('models.hidden') }}</span>
                  </td>
                  <td>{{ m.name }}</td>
                  <td class="mono muted">{{ m.maxInputTokens ? Math.round(m.maxInputTokens / 1000) + 'k' : '—' }}</td>
                  <td class="mono muted">{{ m.maxOutputTokens ? Math.round(m.maxOutputTokens / 1000) + 'k' : '—' }}</td>
                  <td>
                    <span v-if="m.tools" class="tag">{{ t('models.tool') }}</span>
                    <span v-if="m.vision" class="tag">{{ t('models.vision') }}</span>
                    <span v-if="m.reasoning" class="tag tag-reason">{{ t('models.reasoning') }}</span>
                    <span v-if="!m.tools && !m.vision && !m.reasoning" class="muted">—</span>
                  </td>
                  <td>
                    <span class="badge" :class="sourceClass(m)">{{ sourceLabel(m) }}</span>
                  </td>
                  <td class="actions">
                    <button class="btn btn-ghost btn-sm" :disabled="!canManage(m) || togglingHidden.has(modelId(m))" @click="toggleHidden(m)">
                      {{ m.hidden ? t('models.show') : t('models.hide') }}
                    </button>
                    <button class="btn btn-ghost btn-sm" :disabled="!canManage(m)" @click="openEdit(m)">{{ t('common.edit') }}</button>
                    <button class="btn btn-danger btn-sm" :disabled="!canManage(m)" @click="remove(m)">{{ t('common.delete') }}</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>

    <!-- 新增 / 编辑弹窗 -->
    <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <div class="modal">
        <h3 class="modal-title">{{ editingId ? t('models.editTitle') : t('models.addTitle') }}</h3>

        <div class="field">
          <label>{{ t('models.colId') }}</label>
          <input v-model="form.id" type="text" class="input" :disabled="!!editingId" :placeholder="t('models.idPlaceholder')" />
        </div>
        <div class="field">
          <label>{{ t('models.channel') }}</label>
          <select v-model="form.provider" class="select" :disabled="!!editingId">
            <option v-for="p in providers" :key="p.kind" :value="p.kind">{{ p.label }}</option>
          </select>
        </div>
        <div class="field">
          <label>{{ t('models.colName') }}</label>
          <input v-model="form.name" type="text" class="input" :placeholder="t('models.namePlaceholder')" />
        </div>
        <div class="grid2">
          <div class="field">
            <label>{{ t('models.maxInput') }}</label>
            <input v-model.number="form.maxInputTokens" type="number" min="0" class="input" />
          </div>
          <div class="field">
            <label>{{ t('models.maxOutput') }}</label>
            <input v-model.number="form.maxOutputTokens" type="number" min="0" class="input" />
          </div>
        </div>

        <div class="field">
          <label>{{ t('models.region') }}</label>
          <select v-model="form.region" class="select">
            <option value="cn">{{ t('models.cn') }}</option>
            <option value="intl">{{ t('models.intl') }}</option>
          </select>
        </div>

        <div class="checks">
          <label class="check"><input v-model="form.tools" type="checkbox" /> {{ t('models.tool') }}</label>
          <label class="check"><input v-model="form.vision" type="checkbox" /> {{ t('models.vision') }}</label>
          <label class="check"><input v-model="form.reasoning" type="checkbox" /> {{ t('models.reasoning') }}</label>
        </div>

        <div v-if="formError" class="form-error">{{ formError }}</div>

        <div class="modal-actions">
          <button class="btn btn-ghost" @click="showForm = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitForm">
            {{ saving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.table-wrap { overflow-x: auto; }
/* 渠道分组 */
.groups { display: flex; flex-direction: column; gap: 22px; }
.group-title { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 14px; }
.channel-chip { padding: 2px 10px; border-radius: 999px; background: var(--accent-soft, rgba(127,127,127,.15)); color: var(--accent); font-weight: 700; font-size: 12px; }
.group-sub { font-size: 12px; color: var(--text-2); font-weight: 400; }
.channel-sub { font-size: 12px; color: var(--text-2); font-weight: 500; }
.badge-custom-api { background: rgba(34,197,94,.14); color: #22c55e; border: 1px solid rgba(34,197,94,.3); }
.tag { font-size: 11px; color: var(--text-2); border: 1px solid var(--border-strong); padding: 1px 7px; border-radius: 6px; margin-right: 4px; background: var(--surface-2); }
.tag-reason { color: var(--accent); border-color: var(--accent-soft); }
.badge { margin-left: 4px; }
.actions { white-space: nowrap; }
.btn-sm { padding: 4px 10px; font-size: 12px; margin-left: 6px; }
.btn-danger { color: var(--danger); border-color: var(--danger-soft); }
.btn-danger:hover:not(:disabled) { background: var(--danger-soft); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }

.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: 420px; max-width: 92vw; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
.modal-title { margin: 0 0 16px; font-size: 17px; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 12px; color: var(--text-2); margin-bottom: 5px; }
.input, .select { width: 100%; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.checks { display: flex; gap: 16px; margin: 6px 0 4px; }
.check { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.form-error { color: var(--danger); font-size: 13px; margin: 8px 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
</style>

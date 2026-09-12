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

// 按渠道分组展示：两家都有 glm-5.2 这类同名模型，必须分组才不混淆
const grouped = computed(() => {
  const map = new Map();
  for (const m of models.value) {
    const p = m.provider || 'codebuddy';
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(m);
  }
  // 保持 providers 声明顺序，未声明的渠道追加在后
  const order = providers.value.map((p) => p.kind);
  return [...map.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0]);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    })
    .map(([kind, list]) => ({
      kind,
      label: providers.value.find((p) => p.kind === kind)?.label || kind,
      models: list,
    }));
});

/** 模型对外 id：带渠道前缀（由后端返回 key；兜底用 provider 拼） */
function modelId(m) {
  if (m.key) return m.key;
  const p = m.provider || 'codebuddy';
  return p === 'codebuddy' ? m.id : p + '/' + m.id;
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

      <!-- 按渠道分组：同渠道内是同一上游的模型，跨渠道可能重名（如 glm-5.2） -->
      <div v-else class="groups">
        <section v-for="g in grouped" :key="g.kind" class="group">
          <h3 class="group-title">
            <span class="channel-chip">{{ g.label }}</span>
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
                    <span class="badge" :class="m.builtin === false ? 'badge-custom' : 'badge-neutral'">
                      {{ m.builtin === false ? t('models.custom') : t('models.builtin') }}
                    </span>
                  </td>
                  <td class="actions">
                    <button class="btn btn-ghost btn-sm" :disabled="togglingHidden.has(modelId(m))" @click="toggleHidden(m)">
                      {{ m.hidden ? t('models.show') : t('models.hide') }}
                    </button>
                    <button class="btn btn-ghost btn-sm" :disabled="m.builtin !== false" @click="openEdit(m)">{{ t('common.edit') }}</button>
                    <button class="btn btn-danger btn-sm" :disabled="m.builtin !== false" @click="remove(m)">{{ t('common.delete') }}</button>
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

<script setup>
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRequest } from 'alova/client';
import { api } from '@/api';

const { t } = useI18n();

const { data: listData, loading, send: reload } = useRequest(() => api.listCustomApis());

const apis = computed(() => listData.value?.apis || []);

/* ---- 新增 / 编辑 endpoint 弹窗 ---- */
const showForm = ref(false);
const editingId = ref(null);
const saving = ref(false);
const testing = ref(false);
const testMsg = ref('');
const formError = ref('');

const form = reactive({
  name: '',
  baseUrl: '',
  apiKey: '',
  modelPrefix: 'oc',
  models: '',
  enabled: true,
});

function resetForm() {
  Object.assign(form, { name: '', baseUrl: '', apiKey: '', modelPrefix: 'oc', models: '', enabled: true });
  formError.value = '';
  testMsg.value = '';
}

function openAdd() {
  editingId.value = null;
  resetForm();
  showForm.value = true;
}

function openEdit(a) {
  editingId.value = a.id;
  resetForm();
  Object.assign(form, {
    name: a.name || '',
    baseUrl: a.baseUrl || '',
    apiKey: '', // 不回显旧 key；留空表示不修改
    modelPrefix: a.modelPrefix || 'oc',
    models: (a.models || []).join(', '),
    enabled: a.enabled !== false,
  });
  showForm.value = true;
}

async function submitForm() {
  saving.value = true;
  formError.value = '';
  try {
    const payload = {
      name: form.name,
      baseUrl: form.baseUrl,
      modelPrefix: form.modelPrefix || 'oc',
      models: form.models,
      enabled: form.enabled,
    };
    // 编辑且未填新 key 时，不传递 apiKey（后端保留旧值）
    if (form.apiKey) payload.apiKey = form.apiKey;
    if (editingId.value) {
      await api.updateCustomApi(editingId.value, payload);
    } else {
      payload.apiKey = form.apiKey;
      await api.addCustomApi(payload);
    }
    showForm.value = false;
    await reload();
  } catch (e) {
    formError.value = e.message || 'save failed';
  } finally {
    saving.value = false;
  }
}

async function remove(a) {
  if (!window.confirm(t('customApis.confirmDelete'))) return;
  try {
    await api.deleteCustomApi(a.id);
    await reload();
  } catch (e) {
    window.alert(t('customApis.deleteError') + ': ' + e.message);
  }
}

async function test(a) {
  testing.value = true;
  testMsg.value = '';
  try {
    const r = await api.testCustomApi(a.id);
    if (r && r.ok) testMsg.value = t('customApis.testOk', { count: r.modelCount || 0 });
    else testMsg.value = t('customApis.testFail', { msg: (r && r.error) || ('HTTP ' + (r && r.status)) });
  } catch (e) {
    testMsg.value = t('customApis.testFail', { msg: e.message });
  } finally {
    testing.value = false;
  }
}

/**
 * 模型数量：优先用后端返回的 modelCount（白名单或已缓存的上游模型数），
 * 回退到白名单长度。返回 null 表示尚未拉取到（界面显示 /models 提示）。
 */
function modelCount(a) {
  if (typeof a.modelCount === 'number' && a.modelCount > 0) return a.modelCount;
  if (a.models && a.models.length) return a.models.length;
  return null;
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>{{ t('customApis.title') }}</h1>
        <p class="desc">{{ t('customApis.desc') }}</p>
      </div>
      <button class="btn primary" @click="openAdd">{{ t('customApis.add') }}</button>
    </header>

    <p class="usage-hint">{{ t('customApis.usageHint') }}</p>

    <div v-if="loading" class="empty">{{ t('common.loading') }}</div>

    <table v-else class="tbl">
      <thead>
        <tr>
          <th>{{ t('customApis.colName') }}</th>
          <th>{{ t('customApis.colPrefix') }}</th>
          <th>{{ t('customApis.colBaseUrl') }}</th>
          <th>{{ t('customApis.colModels') }}</th>
          <th>{{ t('customApis.colStatus') }}</th>
          <th class="actions-col"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in apis" :key="a.id">
          <td>{{ a.name || '—' }}</td>
          <td><code>{{ a.modelPrefix || 'oc' }}</code></td>
          <td class="mono">{{ a.baseUrl }}</td>
          <td>
            <span v-if="modelCount(a)">{{ modelCount(a) }} {{ t('customApis.colModels') }}</span>
            <span v-else class="muted">/models</span>
          </td>
          <td>
            <span class="badge" :class="a.enabled ? 'ok' : 'off'">
              {{ a.enabled ? '●' : '○' }}
            </span>
          </td>
          <td class="actions-col">
            <button class="btn ghost" @click="test(a)" :disabled="testing">{{ t('customApis.test') }}</button>
            <button class="btn ghost" @click="openEdit(a)">{{ t('common.edit') }}</button>
            <button class="btn danger" @click="remove(a)">{{ t('common.delete') }}</button>
          </td>
        </tr>
        <tr v-if="!apis.length">
          <td colspan="6" class="empty">{{ t('common.noData') }}</td>
        </tr>
      </tbody>
    </table>

    <p v-if="testMsg" class="test-msg">{{ testMsg }}</p>

    <!-- 新增 / 编辑 弹窗 -->
    <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <div class="modal">
        <h3>{{ editingId ? t('customApis.editTitle') : t('customApis.addTitle') }}</h3>

        <label class="fld">
          <span>{{ t('customApis.name') }}</span>
          <input v-model="form.name" :placeholder="t('customApis.namePlaceholder')" />
        </label>
        <label class="fld">
          <span>{{ t('customApis.baseUrl') }}</span>
          <input v-model="form.baseUrl" :placeholder="t('customApis.baseUrlPlaceholder')" />
        </label>
        <label class="fld">
          <span>{{ t('customApis.apiKey') }}</span>
          <input v-model="form.apiKey" type="password" autocomplete="off" :placeholder="editingId ? '（留空不修改）' : t('customApis.apiKeyPlaceholder')" />
        </label>
        <div class="fld-row">
          <label class="fld">
            <span>{{ t('customApis.modelPrefix') }}</span>
            <input v-model="form.modelPrefix" :placeholder="t('customApis.modelPrefixPlaceholder')" />
          </label>
          <label class="fld">
            <span>{{ t('customApis.models') }}</span>
            <input v-model="form.models" :placeholder="t('customApis.modelsPlaceholder')" />
          </label>
        </div>
        <label class="fld check">
          <input type="checkbox" v-model="form.enabled" />
          <span>{{ t('customApis.enabled') }} — {{ t('customApis.enabledHint') }}</span>
        </label>

        <p v-if="formError" class="err">{{ formError }}</p>

        <div class="modal-actions">
          <button class="btn ghost" @click="showForm = false">{{ t('customApis.cancel') }}</button>
          <button class="btn primary" :disabled="saving" @click="submitForm">
            {{ saving ? t('common.saving') : t('customApis.save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 22px 26px 60px; max-width: 1080px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.page-head h1 { font-size: 20px; margin: 0 0 4px; }
.desc { color: var(--text-2); font-size: 13px; max-width: 720px; line-height: 1.6; margin: 0; }
.usage-hint { color: var(--text-2); font-size: 12.5px; background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 12px; margin: 14px 0 18px; }
.tbl { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.tbl th, .tbl td { padding: 11px 13px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
.tbl th { color: var(--text-2); font-weight: 600; background: var(--surface-2); }
.tbl tr:last-child td { border-bottom: none; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--text-2); }
code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; font-size: 12px; }
.muted { color: var(--text-2); }
.badge.ok { color: var(--success); }
.badge.off { color: var(--text-2); }
.actions-col { white-space: nowrap; width: 1%; }
.actions-col .btn { margin-left: 6px; }
.empty { color: var(--text-2); text-align: center; padding: 28px; }
.test-msg { margin-top: 12px; font-size: 13px; color: var(--primary-text); background: var(--primary-soft); border: 1px solid var(--primary); border-radius: 10px; padding: 8px 12px; }

.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: min(560px, 92vw); background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
.modal h3 { margin: 0 0 16px; font-size: 16px; }
.fld { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; font-size: 13px; }
.fld > span { color: var(--text-2); }
.fld input { padding: 9px 11px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 13px; }
.fld.check { flex-direction: row; align-items: center; gap: 8px; }
.fld-row { display: flex; gap: 12px; }
.fld-row .fld { flex: 1; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.err { color: var(--danger); font-size: 13px; margin: 4px 0 12px; }

.btn { border: 1px solid var(--border); background: var(--surface-2); color: var(--text); padding: 8px 14px; border-radius: 9px; font-size: 13px; cursor: pointer; font-weight: 550; }
.btn:hover { border-color: var(--primary); }
.btn.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.btn.ghost { background: transparent; }
.btn.danger { color: var(--danger); border-color: var(--danger-soft); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
</style>

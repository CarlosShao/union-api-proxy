<script setup>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '@/api';

const { t } = useI18n();
const router = useRouter();

const accounts = ref([]);
const pool = ref({ mode: 'pool', strategy: 'round-robin', pinnedId: null });
const autoCheckin = ref(true);
const autoCheckinSaving = ref(false);
const loading = ref(false);
const notice = ref('');
const showAdd = ref(false);
const newName = ref('');
const showImport = ref(false);
const importRt = ref('');
const importName = ref('');
const importDomain = ref('');
const importing = ref(false);
const showVscode = ref(false);
const importingVscode = ref(false);

// 每日签到：每个账号的签到状态，key 为账号 id
const checkinMap = ref({});
const checkinLoading = ref(false);
const checkingId = ref('');

// 渠道（provider）：tab 切换；pools 保存各渠道的池配置与账号数
const providers = ref([]);
const activeChannel = ref('codebuddy');
const pools = ref({});
const activeProvider = computed(() => providers.value.find((p) => p.kind === activeChannel.value) || { kind: activeChannel.value, label: activeChannel.value });
const activePool = computed(() => pools.value[activeChannel.value] || { mode: 'pool', strategy: 'round-robin', pinnedId: null, accountCount: 0 });

// 当前渠道的账号（账号表按渠道过滤展示）
const channelAccounts = computed(() => accounts.value.filter((a) => (a.provider || 'codebuddy') === activeChannel.value));

// 积分余额：每个账号的剩余/总积分，key 为账号 id
const creditsMap = ref({});
const creditsLoading = ref(false);

const mode = computed({
  get: () => pool.value.mode,
  set: (v) => setMode(v),
});

// 已存在从 VSCode 插件读取的账号时不重复展示「从插件读取」入口
const vscodeAccountExists = computed(() => accounts.value.some((a) => a.source === 'vscode'));

async function load() {
  loading.value = true;
  try {
    const r = await api.listAccounts();
    accounts.value = r.accounts || [];
    providers.value = r.providers || [];
    pools.value = r.pools || {};
    // 渠道列表变化时修正当前选中项，避免指向不存在的渠道
    if (providers.value.length && !providers.value.some((p) => p.kind === activeChannel.value)) {
      activeChannel.value = providers.value[0].kind;
    }
    pool.value = r.pools?.[activeChannel.value] || r.pool || { mode: 'pool', strategy: 'round-robin', pinnedId: null };
    autoCheckin.value = r.autoCheckin !== false;
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    loading.value = false;
  }
  loadCheckinAll();
  loadCreditsAll();
}

// 切换渠道 tab：账号列表按渠道过滤，池配置随之切换
function switchChannel(kind) {
  activeChannel.value = kind;
  pool.value = pools.value[kind] || { mode: 'pool', strategy: 'round-robin', pinnedId: null };
  load();
}

// 查询单个账号的积分余额
async function loadCredits(acct) {
  try {
    const r = await api.credits(acct.id);
    if (r?.usageLeft !== undefined) {
      creditsMap.value = { ...creditsMap.value, [acct.id]: r };
    }
  } catch (e) {
    creditsMap.value = { ...creditsMap.value, [acct.id]: { __error: e?.message || t('accounts.creditsFail') } };
  }
}

// 并行查询所有账号的积分余额（不阻塞，静默失败）
async function loadCreditsAll() {
  creditsLoading.value = true;
  try {
    await Promise.allSettled(accounts.value.map((a) => loadCredits(a)));
  } finally {
    creditsLoading.value = false;
  }
}

// 查询单个账号的签到状态
async function loadCheckin(acct) {
  try {
    const r = await api.checkinStatus(acct.id);
    if (r?.data) {
      checkinMap.value = { ...checkinMap.value, [acct.id]: r.data };
    }
  } catch (e) {
    checkinMap.value = { ...checkinMap.value, [acct.id]: { __error: e?.message || t('accounts.checkinFail') } };
  }
}

// 并行查询所有账号的签到状态（不阻塞，静默失败）
async function loadCheckinAll() {
  checkinLoading.value = true;
  try {
    await Promise.allSettled(accounts.value.map((a) => loadCheckin(a)));
  } finally {
    checkinLoading.value = false;
  }
}

// 执行单个账号签到
async function doCheckin(acct) {
  if (checkingId.value) return;
  checkingId.value = acct.id;
  try {
    const r = await api.dailyCheckin(acct.id);
    if (r?.alreadyCheckedIn) notice.value = t('accounts.checkinAlready') + '：' + (acct.name || acct.nickname || acct.uid);
    else notice.value = t('accounts.checkinSuccess') + '：' + (acct.name || acct.nickname || acct.uid);
  } catch (e) {
    notice.value = t('accounts.checkinFail') + '：' + (acct.name || acct.nickname || acct.uid) + ' — ' + e.message;
  } finally {
    checkingId.value = '';
    await loadCheckin(acct);
  }
}

function isCheckedIn(s) {
  if (!s) return false;
  return !!(s.today_checked_in || s.todayCheckedIn || s.already_checked_in || s.alreadyCheckedIn
    || s.checked_in || s.checkedIn || s.has_checked_in || s.hasCheckedIn);
}

function fmtTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function checkinState(acct) {
  const s = checkinMap.value[acct.id];
  if (!s) return null;
  if (s.__error) return { kind: 'error', text: s.__error };
  if (s.active === false) return { kind: 'off', text: t('accounts.checkinActivityOff') };
  if (isCheckedIn(s)) return { kind: 'done', text: t('accounts.checkinToday') };
  const nextAt = acct.checkinNextAt;
  if (autoCheckin.value && nextAt && nextAt > Date.now()) {
    return { kind: 'todo', text: t('accounts.checkinNotToday') + ' · ' + t('accounts.autoCheckinScheduled', { time: fmtTime(nextAt) }) };
  }
  return { kind: 'todo', text: t('accounts.checkinNotToday') };
}

function creditsText(acct) {
  const c = creditsMap.value[acct.id];
  if (!c) return '';
  if (c.__error) return '-';
  const left = typeof c.usageLeft === 'number' ? c.usageLeft : 0;
  return String(left);
}

// 今日消耗（积分）：当前 usageUsed - 今日 0 时快照 usageUsed；无快照时为 '-'。
function todayUsedText(acct) {
  const c = creditsMap.value[acct.id];
  if (!c) return '';
  if (c.__error) return '-';
  if (typeof c.todayUsed !== 'number') return '-';
  return String(c.todayUsed);
}

async function setMode(v) {
  try {
    // 切到指定账号时自动选中当前 pin 的账号（无则选第一个），
    // 避免 pinnedId 为空时指定模式静默回退成轮询
    let pinnedId = pool.value.pinnedId;
    if (v === 'pinned' && !pinnedId) {
      const first = channelAccounts.value[0];
      if (first) pinnedId = first.id;
    }
    const r = await api.setPool(pinnedId ? { mode: v, pinnedId, provider: activeChannel.value } : { mode: v, provider: activeChannel.value });
    pool.value = r;
    notice.value = '';
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

async function pin(id) {
  try {
    const r = await api.setPool({ mode: 'pinned', pinnedId: id, provider: activeChannel.value });
    pool.value = r;
    notice.value = '';
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

async function openAdd() {
  showAdd.value = true;
  showImport.value = false;
  showVscode.value = false;
  newName.value = '';
}

async function doAdd() {
  const name = newName.value.trim();
  try {
    const d = await api.accountLogin(name, activeChannel.value);
    window.open(d.authUrl, '_blank');
    notice.value = t('accounts.loginStarted');
    pollLogin(d.state);
    showAdd.value = false;
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

async function openImport() {
  showImport.value = true;
  showAdd.value = false;
  showVscode.value = false;
  importRt.value = '';
  importName.value = '';
  importDomain.value = '';
}

async function openVscode() {
  showVscode.value = true;
  showAdd.value = false;
  showImport.value = false;
}

async function doVscodeImport() {
  importingVscode.value = true;
  notice.value = '';
  try {
    const r = await api.importVscode();
    if (r.ok) {
      notice.value = t('accounts.vscodeOk');
      showVscode.value = false;
      load();
    } else {
      notice.value = r.alreadyAdded ? t('accounts.vscodeAlreadyAdded') : (r.error || t('accounts.vscodeFail'));
      showVscode.value = false;
      load();
    }
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    importingVscode.value = false;
  }
}

async function doImport() {
  if (!importRt.value.trim()) { notice.value = t('accounts.importRtRequired'); return; }
  importing.value = true;
  notice.value = '';
  try {
    await api.importAccount({ refreshToken: importRt.value.trim(), name: importName.value.trim(), domain: importDomain.value.trim() });
    notice.value = t('accounts.importOk');
    showImport.value = false;
    load();
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    importing.value = false;
  }
}

function pollLogin(state) {
  const timer = setInterval(async () => {
    try {
      const sd = await api.accountLoginStatus(state);
      if (sd.status === 'success') {
        clearInterval(timer);
        notice.value = t('accounts.loginOk');
        load();
      } else if (sd.status === 'error' || sd.status === 'timeout') {
        clearInterval(timer);
        notice.value = t('common.error') + ': ' + (sd.error || t('login.timeout'));
      }
    } catch (e) {
      clearInterval(timer);
      notice.value = t('common.error') + ': ' + e.message;
    }
  }, 2000);
}

async function onAutoCheckinChange(ev) {
  const next = !!ev.target.checked;
  const prev = autoCheckin.value;
  autoCheckin.value = next;
  autoCheckinSaving.value = true;
  try {
    const r = await api.setAutoCheckin(next);
    autoCheckin.value = r.autoCheckin !== false;
    notice.value = autoCheckin.value ? t('accounts.autoCheckinOn') : t('accounts.autoCheckinOff');
  } catch (e) {
    autoCheckin.value = prev;
    notice.value = t('common.error') + ': ' + e.message;
  } finally {
    autoCheckinSaving.value = false;
  }
}

async function rename(acct) {
  const name = prompt(t('accounts.renamePrompt'), acct.name);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    await api.renameAccount(acct.id, trimmed);
    notice.value = '';
    load();
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

async function remove(acct) {
  if (!confirm(t('accounts.confirmDelete', { name: acct.name }))) return;
  try {
    await api.deleteAccount(acct.id);
    notice.value = '';
    load();
  } catch (e) {
    notice.value = t('common.error') + ': ' + e.message;
  }
}

function fmt(ms) {
  if (!ms) return '-';
  // 紧凑格式（去秒）：长格式会把 Token 过期/使用情况两列撑宽，窄视口下表格溢出
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sourceText(s) {
  if (s === 'vscode') return t('overview.sourceVscode');
  if (s === 'oauth') return t('overview.sourceOauth');
  if (s === 'file') return t('overview.sourceFile');
  return t('common.unknown');
}

load();
</script>

<template>
  <div>
    <div class="card">
      <div class="head">
        <h2 class="card-title">
          {{ t('accounts.title') }}
          <span class="tip">
            <span class="tip-icon">?</span>
            <span class="tip-text">{{ t('accounts.addHint') }}</span>
          </span>
        </h2>
        <div class="head-actions">
          <!-- VSCode 插件导入的是 CodeBuddy 登录态，仅该渠道显示 -->
          <button v-if="activeChannel === 'codebuddy' && !vscodeAccountExists" class="btn btn-ghost" @click="openVscode">{{ t('accounts.vscode') }}</button>
          <button v-if="activeChannel === 'codebuddy'" class="btn btn-ghost" @click="openImport">{{ t('accounts.import') }}</button>
          <button class="btn btn-primary" @click="openAdd">{{ t('accounts.add') }}</button>
        </div>
      </div>

      <!-- 渠道切换：每个渠道有独立的账号池与池配置 -->
      <div v-if="providers.length > 1" class="channel-tabs">
        <button
          v-for="p in providers"
          :key="p.kind"
          class="channel-tab"
          :class="{ active: p.kind === activeChannel }"
          @click="switchChannel(p.kind)"
        >
          {{ p.label }}
          <span class="channel-count">{{ (pools[p.kind] && pools[p.kind].accountCount) || 0 }}</span>
        </button>
      </div>

      <div class="mode-row">
        <span class="mode-label">
          {{ t('accounts.mode') }}
          <span class="tip">
            <span class="tip-icon">?</span>
            <span class="tip-text">{{ t('accounts.modeHint') }}</span>
          </span>
        </span>
        <label class="radio">
          <input type="radio" value="pool" v-model="mode" />
          <span>{{ t('accounts.modePool') }}</span>
        </label>
        <label class="radio">
          <input type="radio" value="pinned" v-model="mode" />
          <span>{{ t('accounts.modePinned') }}</span>
        </label>
        <span class="hint" v-if="pool.mode === 'pinned'">{{ t('accounts.pinnedHint') }}</span>
        <span class="mode-spacer"></span>
        <span class="mode-label">
          {{ t('accounts.autoCheckin') }}
          <span class="tip">
            <span class="tip-icon">?</span>
            <span class="tip-text">{{ t('accounts.autoCheckinHint') }}</span>
          </span>
        </span>
        <label class="switch">
          <input type="checkbox" :checked="autoCheckin" :disabled="autoCheckinSaving" @change="onAutoCheckinChange" />
          <span class="slider"></span>
        </label>
      </div>

      <p v-if="notice" class="hint notice">{{ notice }}</p>

      <div v-if="loading" class="muted">{{ t('common.loading') }}</div>
      <div v-else-if="!channelAccounts.length" class="muted">{{ t('accounts.empty') }}</div>

      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('accounts.colName') }}</th>
              <th>{{ t('accounts.colNickname') }}</th>
              <th>{{ t('overview.uid') }}</th>
              <th>{{ t('overview.source') }}</th>
              <th>{{ t('overview.tokenExpire') }}</th>
              <th>{{ t('accounts.colUsed') }}</th>
              <th>{{ t('accounts.credits') }}</th>
              <th>{{ t('accounts.checkin') }}</th>
              <th class="ops-th">{{ t('accounts.colOps') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in channelAccounts" :key="a.id" :class="{ pinned: pool.mode === 'pinned' && pool.pinnedId === a.id }">
              <td class="strong">
                <span v-if="pool.mode === 'pinned' && pool.pinnedId === a.id" class="badge badge-primary">{{ t('accounts.pinnedBadge') }}</span>
                {{ a.name || '-' }}
              </td>
              <td>{{ a.nickname || '-' }}</td>
              <td><code>{{ a.uid || '-' }}</code></td>
              <td>{{ sourceText(a.source) }}</td>
              <td class="muted">{{ fmt(a.expiresAt) }}</td>
              <td class="muted">{{ a.useCount }} / {{ fmt(a.lastUsedAt) }}</td>
              <td class="credits-cell">
                <template v-if="creditsText(a)">
                  <span class="credits-value">{{ creditsText(a) }}</span>
                  <span class="credits-today">（{{ t('accounts.todayUsed') }} <b>{{ todayUsedText(a) }}</b>）</span>
                </template>
                <span v-else class="muted">{{ creditsLoading ? t('common.loading') : '-' }}</span>
              </td>
              <td>
                <template v-if="checkinState(a)">
                  <span class="checkin-state" :class="checkinState(a).kind">{{ checkinState(a).text }}</span>
                </template>
                <span v-else class="muted">{{ checkinLoading ? t('common.loading') : '-' }}</span>
              </td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" :disabled="!!checkingId" @click="doCheckin(a)">{{ checkingId === a.id ? t('accounts.checkinDoing') : t('accounts.checkin') }}</button>
                <button class="btn btn-ghost btn-sm" @click="pin(a.id)">{{ t('accounts.pin') }}</button>
                <button class="btn btn-ghost btn-sm" @click="rename(a)">{{ t('common.edit') }}</button>
                <button class="btn btn-danger btn-sm" @click="remove(a)">{{ t('common.delete') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="showAdd" class="card add-card">
      <h3 class="card-title">{{ t('accounts.addTitle') }}</h3>
      <div class="field-label">{{ t('accounts.nameLabel') }}</div>
      <input class="input" v-model="newName" :placeholder="t('accounts.namePlaceholder')" />
      <div class="actions">
        <button class="btn btn-primary" @click="doAdd">{{ t('accounts.startLogin') }}</button>
        <button class="btn btn-ghost" @click="showAdd = false">{{ t('common.cancel') }}</button>
      </div>
    </div>

    <div v-if="showImport" class="card add-card">
      <h3 class="card-title">{{ t('accounts.importTitle') }}</h3>
      <div class="field-label">{{ t('accounts.nameLabel') }}</div>
      <input class="input" v-model="importName" :placeholder="t('accounts.namePlaceholder')" />
      <div class="field-label">{{ t('accounts.importRt') }}</div>
      <textarea class="input textarea" v-model="importRt" :placeholder="t('accounts.importRtPlaceholder')"></textarea>
      <div class="field-label">{{ t('accounts.importDomain') }}</div>
      <input class="input" v-model="importDomain" :placeholder="t('accounts.importDomainPlaceholder')" />
      <p class="hint">{{ t('accounts.importHint') }}</p>
      <div class="actions">
        <button class="btn btn-primary" :disabled="importing" @click="doImport">{{ importing ? t('common.saving') : t('accounts.importConfirm') }}</button>
        <button class="btn btn-ghost" @click="showImport = false">{{ t('common.cancel') }}</button>
      </div>
    </div>

    <div v-if="showVscode" class="card add-card">
      <h3 class="card-title">{{ t('accounts.vscodeTitle') }}</h3>
      <p class="hint">{{ t('accounts.vscodeHint') }}</p>
      <div class="actions">
        <button class="btn btn-primary" :disabled="importingVscode" @click="doVscodeImport">{{ importingVscode ? t('accounts.vscodeReading') : t('accounts.vscodeConfirm') }}</button>
        <button class="btn btn-ghost" @click="showVscode = false">{{ t('common.cancel') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.head-actions { display: flex; align-items: center; gap: 8px; }
/* 渠道切换 tab：每个渠道独立的账号池 */
.channel-tabs { display: flex; gap: 6px; margin: 4px 0 14px; border-bottom: 1px solid var(--border); }
.channel-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px; font-size: 13px; font-weight: 600;
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--text-2); cursor: pointer; margin-bottom: -1px;
}
.channel-tab:hover { color: var(--text-1); }
.channel-tab.active { color: var(--primary); border-bottom-color: var(--primary); }
.channel-count {
  display: inline-block; min-width: 18px; padding: 0 5px;
  font-size: 11px; line-height: 17px; text-align: center;
  background: var(--bg-3, rgba(127,127,127,.15)); border-radius: 9px; color: var(--text-2);
}
.mode-row { display: flex; align-items: center; gap: 18px; margin: 8px 0 14px; flex-wrap: wrap; }
.mode-spacer { flex: 1; min-width: 12px; }
.mode-label { font-size: 13px; color: var(--text-2); font-weight: 600; }
.radio { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.radio input { margin: 0; }
.hint { font-size: 12px; }
.notice { margin-top: 10px; }

.tip { position: relative; display: inline-flex; margin-left: 4px; vertical-align: middle; }
.tip-icon {
  width: 15px; height: 15px; border-radius: 50%;
  background: var(--text-2); color: #fff;
  font-size: 10px; font-weight: 700; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: help;
}
.tip-text {
  position: absolute; top: calc(100% + 8px); left: 0;
  width: 280px; max-width: 70vw;
  padding: 9px 11px;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
  font-size: 12px; font-weight: 400; line-height: 1.5;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  z-index: 40; text-align: left; white-space: normal;
  visibility: hidden; opacity: 0; pointer-events: none;
  transition: opacity 0.15s ease;
}
.tip:hover .tip-text { visibility: visible; opacity: 1; }
.table-wrap { overflow-x: auto; }
/* 单元格文本不换行：昵称/来源等被挤压竖排会撑高行高，操作列垂直居中后上下留出大片空白。
   UID 列例外 —— 允许缩窄并以省略号截断，避免长 UUID 把表格撑出横向滚动。 */
.table td { vertical-align: middle; white-space: nowrap; }
.table td code {
  display: inline-block; max-width: 100px;
  overflow: hidden; text-overflow: ellipsis;
  vertical-align: middle; white-space: nowrap;
}
/* 紧凑内边距：给窄视口留出表格总宽余量 */
.table th, .table td { padding: 9px 7px; }
.ops .btn-sm { padding: 4px 7px; }
tr.pinned td { background: var(--primary-soft); }
.strong { font-weight: 600; }
.ops { display: flex; gap: 4px; justify-content: flex-end; white-space: nowrap; }
.ops-th { text-align: right; }
.checkin-state { font-size: 12px; font-weight: 600; white-space: nowrap; }
.checkin-state.done { color: var(--success, #3fb950); }
.checkin-state.todo { color: var(--warning, #d29922); }
.checkin-state.off { color: var(--text-2); }
.checkin-state.error { color: var(--danger, #f85149); }
.credits-cell { white-space: nowrap; }
.credits-value { font-weight: 600; color: var(--text); }
.credits-today { font-size: 12px; color: var(--text-2); }
.credits-today b { color: var(--warning, #d29922); font-weight: 600; }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.add-card { margin-top: 16px; }
.input { width: 100%; max-width: 420px; }
.textarea { min-height: 90px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; resize: vertical; }
.actions { display: flex; gap: 10px; margin-top: 14px; }
.badge { margin-right: 6px; }
</style>
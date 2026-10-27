<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from 'vue';
import { NButton, NSelect } from 'naive-ui';
import type { ImportPreviewResponse, ImportProfileReport, ImportResultResponse } from '@gacha/contracts';
import ImportProfileCard from '../components/ImportProfileCard.vue';
import { ApiError, userRequest } from '../auth.js';
import { currentProfile, profiles, profilesLoading, refreshProfiles, timezoneLabel } from '../profiles.js';
import { exportVersions, importErrorMessage, MAX_FILE_BYTES, skippedGameLabel } from '../uigf.js';

const fileInput = ref<HTMLInputElement | null>(null), filename = ref(''), fileBytes = ref(0);
const document = shallowRef<unknown>(null), preview = shallowRef<ImportPreviewResponse | null>(null), result = shallowRef<ImportResultResponse | null>(null);
const selected = ref<number[]>([]), phase = ref<'idle' | 'reading' | 'preview' | 'import'>('idle');
const error = ref(''), exportError = ref(''), exportBusy = ref(false), exportVersion = ref('v4.0'), needsPreview = ref(false);
const busy = computed(() => phase.value !== 'idle');
const eligible = (report: ImportProfileReport) => !report.conflicts && !report.blockers.length;
const chosen = computed(() => preview.value?.profiles.filter((profile) => selected.value.includes(profile.index)) ?? []);
const inserted = computed(() => chosen.value.reduce((total, profile) => total + profile.inserted, 0));
const enriched = computed(() => chosen.value.reduce((total, profile) => total + profile.enriched, 0));
const canImport = computed(() => !busy.value && !needsPreview.value && chosen.value.length > 0 && chosen.value.every(eligible));
const resultInserted = computed(() => result.value?.profiles.reduce((total, profile) => total + profile.inserted, 0) ?? 0);
let active = true, revision = 0;
onUnmounted(() => { active = false; revision++; document.value = null; preview.value = null; result.value = null; });

function clearFile(resetInput = true) {
  revision++; document.value = null; preview.value = null; result.value = null; selected.value = [];
  filename.value = ''; fileBytes.value = 0; error.value = ''; needsPreview.value = false;
  if (resetInput && fileInput.value) fileInput.value.value = '';
}
async function chooseFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || busy.value) return;
  clearFile(false); filename.value = file.name; fileBytes.value = file.size;
  if (file.size > MAX_FILE_BYTES) { error.value = '文件超过 16 MiB，请减少单次文件内容。'; return; }
  const requestRevision = revision;
  phase.value = 'reading';
  try {
    const text = await file.text();
    if (!active || requestRevision !== revision) return;
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { error.value = '无法解析 JSON，请检查文件内容是否完整。'; return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('info' in parsed)) {
      error.value = importErrorMessage(new ApiError('UNSUPPORTED_FORMAT')); return;
    }
    document.value = parsed;
  } catch { if (active && requestRevision === revision) error.value = '文件读取失败，请重新选择。'; }
  finally { if (active && requestRevision === revision) phase.value = 'idle'; }
  if (active && requestRevision === revision && document.value) await previewFile();
}
async function previewFile() {
  if (!document.value || busy.value) return;
  const requestRevision = revision, previousSelection = preview.value ? [...selected.value] : null;
  phase.value = 'preview'; error.value = ''; result.value = null; needsPreview.value = true;
  try {
    const response = await userRequest<ImportPreviewResponse>('/api/uigf/preview', { document: document.value }, 120000);
    if (!active || requestRevision !== revision) return;
    preview.value = response;
    selected.value = response.profiles.filter((profile) => eligible(profile) && (!previousSelection || previousSelection.includes(profile.index))).map((profile) => profile.index);
    needsPreview.value = false;
  } catch (cause) { if (active && requestRevision === revision) error.value = importErrorMessage(cause); }
  finally { if (active && requestRevision === revision) phase.value = 'idle'; }
}
function toggle(index: number) {
  selected.value = selected.value.includes(index) ? selected.value.filter((value) => value !== index) : [...selected.value, index];
}
async function importFile() {
  if (!canImport.value || !preview.value) return;
  const requestRevision = revision;
  phase.value = 'import'; error.value = '';
  try {
    const response = await userRequest<ImportResultResponse>('/api/uigf/import', { document: document.value,
      previewToken: preview.value.previewToken, profileIndexes: [...selected.value] }, 120000);
    if (!active || requestRevision !== revision) return;
    result.value = response; preview.value = null; selected.value = []; needsPreview.value = true;
    await refreshProfiles();
  } catch (cause) {
    if (!active || requestRevision !== revision) return;
    needsPreview.value = true;
    error.value = cause instanceof ApiError && ['NETWORK_ERROR', 'REQUEST_FAILED'].includes(cause.code)
      ? '未能确认导入结果，服务端可能已完成写入。请刷新档案列表并重新预览，再决定是否重试；重复记录会去重。'
      : importErrorMessage(cause);
    await refreshProfiles();
  } finally { if (active && requestRevision === revision) phase.value = 'idle'; }
}
async function download() {
  const profile = currentProfile.value, version = exportVersion.value;
  if (!profile || exportBusy.value) return;
  exportBusy.value = true; exportError.value = '';
  try {
    const data = await userRequest<unknown>(`/api/uigf/export/${encodeURIComponent(profile.id)}?version=${encodeURIComponent(version)}`, undefined, 120000);
    if (!active) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
    const link = globalThis.document.createElement('a');
    link.href = url; link.download = `UIGF_${version}_${profile.uid}_${Date.now()}.json`;
    globalThis.document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (cause) { if (active) exportError.value = importErrorMessage(cause); }
  finally { if (active) exportBusy.value = false; }
}
</script>

<template>
  <section class="page-heading">
    <p class="eyebrow">
      DATA MANAGEMENT
    </p><h1>数据管理</h1>
    <p class="muted">
      导入你的祈愿记录，也随时带走一份完整备份。
    </p>
  </section>
  <div class="data-stack">
    <section
      class="surface data-section"
      aria-labelledby="import-title"
    >
      <div class="section-heading">
        <h2 id="import-title">
          导入 UIGF 文件
        </h2><p class="muted">
          支持 v4.0、v4.1、v4.2。一个文件可包含多个原神 UID，确认前可以分别选择。
        </p>
      </div>
      <ol
        class="import-steps"
        aria-label="导入步骤"
      >
        <li :class="{ complete: filename }">
          选择文件
        </li><li :class="{ complete: preview || result }">
          核对并选择 UID
        </li><li :class="{ complete: result }">
          确认导入
        </li>
      </ol>
      <div class="upload-area">
        <div
          class="upload-icon"
          aria-hidden="true"
        >
          ↥
        </div>
        <label
          for="uigf-file"
          class="file-label"
        >选择 UIGF JSON 文件</label>
        <input
          id="uigf-file"
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          :disabled="busy"
          @change="chooseFile"
        >
        <p class="field-hint">
          单次最多 16 MiB、32 个原神档案、100,000 条记录。
        </p>
      </div>
      <div
        v-if="filename"
        class="file-summary"
      >
        <span>{{ filename }} <small>{{ (fileBytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }) }} KiB</small></span>
        <NButton
          size="small"
          quaternary
          :disabled="busy"
          @click="clearFile()"
        >
          清除文件
        </NButton>
      </div>
      <p class="form-help">
        预览会将文件发送到当前服务；只有确认选中的原神档案才会写入。旧工具内部 JSON 不支持导入或迁移。
      </p>
      <p
        v-if="busy"
        class="feedback"
        role="status"
      >
        {{ phase === 'reading' ? '正在读取文件…' : phase === 'preview' ? '正在生成预览…' : '正在合并所选档案，请稍候…' }}
      </p>
      <p
        v-if="error"
        class="feedback error"
        role="alert"
      >
        {{ error }}
      </p>

      <div
        v-if="preview"
        class="import-preview"
      >
        <div class="list-heading">
          <h3>导入预览 <small>{{ preview.version }}</small></h3><span class="profile-caption">{{ preview.profiles.length }} 个原神档案</span>
        </div>
        <p
          v-if="preview.skippedBlocks.length"
          class="feedback"
        >
          本轮跳过：{{ preview.skippedBlocks.map(skippedGameLabel).join('、') }}。
        </p>
        <p
          v-if="!preview.profiles.length"
          class="feedback"
        >
          文件中没有原神档案，没有可导入的数据。
        </p>
        <p
          v-else
          class="field-hint"
        >
          新增、重复和补全均以当前保存的数据计算；补全是重复记录中的一部分。有关键冲突的档案暂不可选。
        </p>
        <div class="import-profile-list">
          <ImportProfileCard
            v-for="profile in preview.profiles"
            :key="profile.index"
            :report="profile"
            selectable
            :selected="selected.includes(profile.index)"
            :disabled="busy || needsPreview"
            @toggle="toggle"
          />
        </div>
        <div
          v-if="preview.profiles.length"
          class="import-confirm"
        >
          <div>
            <strong>已选 {{ chosen.length }} 个 UID</strong><p class="field-hint">
              预计新增 {{ inserted.toLocaleString() }} 条，补全元数据 {{ enriched.toLocaleString() }} 条。未选档案不会写入。
            </p>
          </div>
          <NButton
            type="primary"
            :loading="phase === 'import'"
            :disabled="!canImport"
            @click="importFile"
          >
            确认导入所选档案
          </NButton>
        </div>
        <p class="field-hint">
          预览有效 15 分钟；档案发生变化时需重新预览。
        </p>
      </div>
      <div
        v-if="result"
        class="import-result"
        role="status"
      >
        <p class="feedback success">
          <strong>导入完成 · 新增 {{ resultInserted.toLocaleString() }} 条</strong><br>重复记录已去重，所选档案已保存。
        </p>
        <p
          v-if="result.skippedBlocks.length"
          class="field-hint"
        >
          已跳过：{{ result.skippedBlocks.map(skippedGameLabel).join('、') }}。
        </p>
        <div class="import-profile-list">
          <ImportProfileCard
            v-for="profile in result.profiles"
            :key="profile.index"
            :report="profile"
          />
        </div>
      </div>
      <NButton
        v-if="document && !busy"
        class="repreview-button"
        :disabled="busy"
        @click="previewFile"
      >
        重新预览当前文件
      </NButton>
    </section>

    <section
      class="surface data-section"
      aria-labelledby="export-title"
    >
      <div class="section-heading">
        <h2 id="export-title">
          导出当前档案
        </h2><p class="muted">
          保存当前 UID 的全部记录为 UIGF 文件。
        </p>
      </div>
      <div
        v-if="currentProfile"
        class="export-profile"
      >
        <div>
          <strong>UID {{ currentProfile.uid }}</strong><p class="profile-caption">
            {{ currentProfile.recordCount.toLocaleString() }} 条记录 · {{ timezoneLabel(currentProfile.timezone) }}
          </p>
        </div>
        <span class="status-badge">当前选择</span>
      </div>
      <p
        v-else
        class="feedback"
      >
        {{ profilesLoading ? '正在加载档案…' : '还没有可导出的档案，先导入一份 UIGF 文件。' }}
      </p>
      <div class="export-actions">
        <div class="field">
          <label for="export-version">UIGF 版本</label><NSelect
            id="export-version"
            v-model:value="exportVersion"
            :options="exportVersions"
            :disabled="exportBusy"
            aria-label="导出 UIGF 版本"
          />
        </div>
        <NButton
          :loading="exportBusy"
          :disabled="!currentProfile || exportBusy"
          @click="download"
        >
          下载 UIGF 文件
        </NButton>
      </div>
      <p class="form-help">
        可在档案选择器切换 UID。默认 v4.0；v4.2 的记录 ID 最多 19 位，遇到不兼容提示可改选 v4.0 或 v4.1。
      </p>
      <p
        v-if="exportError"
        class="feedback error"
        role="alert"
      >
        {{ exportError }}
      </p>
    </section>
    <p class="data-footnote">
      当前账号保存了 {{ profiles.length }} 个原神档案。可在档案概览查看时间范围与记录总量。
    </p>
  </div>
</template>

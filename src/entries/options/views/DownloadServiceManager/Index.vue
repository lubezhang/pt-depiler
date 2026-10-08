<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { DataTableHeader } from "vuetify";

import type {
  BulkResult,
  ServiceOverview,
  TorrentFileSummary,
  TorrentId,
  TorrentSummary,
} from "~/application/download-service/service.ts";
import { sendMessage } from "@/messages.ts";
import { defaultDownloadServiceManagerColumns, useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate, formatSize } from "@/options/utils.ts";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const overview = ref<ServiceOverview>();
const torrents = ref<TorrentSummary[]>([]);
const selectedTorrentIds = ref<TorrentId[]>([]);
const detailTorrentId = ref<TorrentId>();
const pendingOperations = ref(new Set<TorrentId>());
const loading = ref(false);
const error = ref("");
const autoRefreshEnabled = ref(false);
const refreshInterval = ref(15);
const refreshFailures = ref(0);
const autoRefreshSuspended = ref(false);
const showSettingsDialog = ref(false);
const settingsDraft = ref({ ...configStore.downloadServiceManager });
const defaultDownloadDirectory = ref("");
const defaultDownloadDirectoryLoading = ref(false);
const settingsSaving = ref(false);
const showDeleteDialog = ref(false);
const deleteData = ref(false);
const showTorrentContextMenu = ref(false);
const contextMenuTorrent = ref<TorrentSummary>();
const contextMenuPosition = ref<[number, number]>([0, 0]);
const showTorrentLocationDialog = ref(false);
const locationTorrent = ref<TorrentSummary>();
const torrentLocation = ref("");
const moveTorrentData = ref(true);
const updatingTorrentLocation = ref(false);
const search = ref("");
const activeFilter = ref("all");
const detailTab = ref("overview");
const torrentFiles = ref<TorrentFileSummary[]>([]);
const filesLoading = ref(false);
const filesError = ref("");
const selectedColumns = computed<string[]>({
  get: () => configStore.tableBehavior.DownloadServiceManager?.columns ?? defaultDownloadServiceManagerColumns,
  set: (columns) => configStore.updateTableBehavior("DownloadServiceManager", "columns", columns),
});

let refreshTimer: number | undefined;
let requestVersion = 0;
let filesRequestVersion = 0;

const downloaderId = computed(() => String(route.params.downloaderId ?? ""));
const downloader = computed(() => metadataStore.downloaders[downloaderId.value]);
const canWrite = computed(() => Boolean(overview.value) && !error.value && pendingOperations.value.size === 0);
const statusFilters = computed(() => {
  const isActive = (torrent: TorrentSummary) => torrent.downloadSpeed > 0 || torrent.uploadSpeed > 0;
  return [
    { key: "all", label: t("DownloadServiceManager.filters.all"), icon: "mdi-torrent", count: torrents.value.length },
    {
      key: "downloading",
      label: t("DownloadServiceManager.filters.downloading"),
      icon: "mdi-download",
      color: "primary",
      count: torrents.value.filter((torrent) => torrent.state === "downloading").length,
    },
    {
      key: "completed",
      label: t("DownloadServiceManager.filters.completed"),
      icon: "mdi-check-circle",
      color: "success",
      count: torrents.value.filter((torrent) => torrent.progress >= 100).length,
    },
    {
      key: "active",
      label: t("DownloadServiceManager.filters.active"),
      icon: "mdi-transfer",
      color: "warning",
      count: torrents.value.filter(isActive).length,
    },
    {
      key: "inactive",
      label: t("DownloadServiceManager.filters.inactive"),
      icon: "mdi-pause-circle-outline",
      count: torrents.value.filter((torrent) => !isActive(torrent)).length,
    },
    {
      key: "stopped",
      label: t("DownloadServiceManager.filters.stopped"),
      icon: "mdi-stop-circle",
      count: torrents.value.filter((torrent) => torrent.state === "paused").length,
    },
    {
      key: "error",
      label: t("DownloadServiceManager.filters.error"),
      icon: "mdi-close-circle",
      color: "error",
      count: torrents.value.filter((torrent) => torrent.state === "error").length,
    },
    {
      key: "waiting",
      label: t("DownloadServiceManager.filters.waiting"),
      icon: "mdi-clock-outline",
      count: torrents.value.filter((torrent) => torrent.state === "queued" || torrent.state === "checking").length,
    },
  ];
});
const folderFilters = computed(() => collectFilterCounts(torrents.value, (torrent) => torrent.savePath));
const selectedTorrent = computed(() => {
  const torrentId = detailTorrentId.value ?? selectedTorrentIds.value[0];
  return torrents.value.find((torrent) => torrent.id === torrentId);
});
const filteredTorrents = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return torrents.value.filter((torrent) => {
    if (!matchesActiveFilter(torrent)) return false;
    if (!query) return true;
    return [torrent.name, torrent.infoHash, torrent.label, torrent.savePath].some((value) =>
      value?.toLocaleLowerCase().includes(query),
    );
  });
});

const fullHeaders = computed(
  () =>
    [
      { title: t("DownloadServiceManager.table.name"), key: "name", minWidth: "18rem", props: { required: true } },
      { title: t("DownloadServiceManager.table.label"), key: "label", width: "120" },
      { title: t("DownloadServiceManager.table.size"), key: "totalSize", align: "end", width: "110" },
      { title: t("DownloadServiceManager.table.progress"), key: "progress", align: "end", width: "90" },
      { title: t("DownloadServiceManager.table.state"), key: "state", align: "center", width: "100" },
      { title: t("DownloadServiceManager.table.uploadSpeed"), key: "uploadSpeed", align: "end", width: "100" },
      { title: t("DownloadServiceManager.table.downloadSpeed"), key: "downloadSpeed", align: "end", width: "100" },
      { title: t("DownloadServiceManager.table.uploaded"), key: "totalUploaded", align: "end", width: "110" },
      { title: t("DownloadServiceManager.table.downloaded"), key: "totalDownloaded", align: "end", width: "110" },
      { title: t("DownloadServiceManager.table.ratio"), key: "ratio", align: "end", width: "75" },
      { title: t("DownloadServiceManager.table.path"), key: "savePath", minWidth: "14rem" },
      { title: t("DownloadServiceManager.table.addedAt"), key: "addedAt", width: "160" },
      { title: t("common.action"), key: "action", sortable: false, width: "108", props: { required: true } },
    ] as (DataTableHeader & { props?: { required?: boolean } })[],
);
const headers = computed(() =>
  fullHeaders.value.filter((header) => header.props?.required || selectedColumns.value.includes(String(header.key))),
);

function clearRefreshTimer() {
  if (refreshTimer !== undefined) {
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

function collectFilterCounts(
  items: TorrentSummary[],
  getValues: (torrent: TorrentSummary) => string | string[] | undefined,
) {
  const counts = new Map<string, number>();
  for (const torrent of items) {
    const values = getValues(torrent);
    for (const value of Array.isArray(values) ? values : [values]) {
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

function matchesActiveFilter(torrent: TorrentSummary) {
  const isActive = torrent.downloadSpeed > 0 || torrent.uploadSpeed > 0;
  if (activeFilter.value === "all") return true;
  if (activeFilter.value === "downloading") return torrent.state === "downloading";
  if (activeFilter.value === "completed") return torrent.progress >= 100;
  if (activeFilter.value === "active") return isActive;
  if (activeFilter.value === "inactive") return !isActive;
  if (activeFilter.value === "stopped") return torrent.state === "paused";
  if (activeFilter.value === "error") return torrent.state === "error";
  if (activeFilter.value === "waiting") return torrent.state === "queued" || torrent.state === "checking";
  if (activeFilter.value.startsWith("folder:")) return torrent.savePath === activeFilter.value.slice("folder:".length);
  return true;
}

async function openSettingsDialog() {
  settingsDraft.value = { ...configStore.downloadServiceManager };
  showSettingsDialog.value = true;
  defaultDownloadDirectory.value = "";
  defaultDownloadDirectoryLoading.value = true;
  try {
    defaultDownloadDirectory.value = await sendMessage("getDownloadServiceDefaultDownloadDirectory", downloaderId.value);
  } catch (caught) {
    runtimeStore.showSnakebar(t("DownloadServiceManager.settings.loadDirectoryFailed"), { color: "error" });
    console.error("[download-service-manager] Failed to load default download directory");
  } finally {
    defaultDownloadDirectoryLoading.value = false;
  }
}

async function saveSettings() {
  const refreshIntervalValue = Number(settingsDraft.value.refreshInterval);
  const normalizedRefreshInterval = Number.isFinite(refreshIntervalValue)
    ? Math.min(3600, Math.max(1, Math.round(refreshIntervalValue)))
    : 15;
  const normalizedDownloadDirectory = defaultDownloadDirectory.value.trim();

  if (!normalizedDownloadDirectory) {
    runtimeStore.showSnakebar(t("DownloadServiceManager.settings.directoryRequired"), { color: "error" });
    return;
  }

  settingsSaving.value = true;
  try {
    const updated = await sendMessage("setDownloadServiceDefaultDownloadDirectory", {
      downloaderId: downloaderId.value,
      path: normalizedDownloadDirectory,
    });
    if (!updated) throw new Error("Download service did not confirm the default directory update.");

    autoRefreshEnabled.value = settingsDraft.value.autoRefreshEnabled;
    refreshInterval.value = normalizedRefreshInterval;
    configStore.updateDownloadServiceManagerSettings({
      autoRefreshEnabled: autoRefreshEnabled.value,
      refreshInterval: normalizedRefreshInterval,
    });
    showSettingsDialog.value = false;
  } catch (caught) {
    runtimeStore.showSnakebar(t("DownloadServiceManager.settings.saveDirectoryFailed"), { color: "error" });
    console.error("[download-service-manager] Failed to set default download directory");
  } finally {
    settingsSaving.value = false;
  }
}

function scheduleRefresh() {
  clearRefreshTimer();
  if (!autoRefreshEnabled.value || autoRefreshSuspended.value || refreshInterval.value <= 0) return;
  refreshTimer = window.setTimeout(async () => {
    await refresh(false);
    scheduleRefresh();
  }, refreshInterval.value * 1000);
}

async function refresh(manual = true) {
  if (loading.value) return;
  const id = downloaderId.value;
  if (!id) return;
  const currentRequest = ++requestVersion;
  loading.value = true;
  if (manual) {
    refreshFailures.value = 0;
    autoRefreshSuspended.value = false;
  }
  try {
    const [nextOverview, nextTorrents] = await Promise.all([
      sendMessage("getDownloadServiceOverview", id),
      sendMessage("listDownloadServiceTorrents", id),
    ]);
    if (currentRequest !== requestVersion || id !== downloaderId.value) return;
    overview.value = nextOverview;
    torrents.value = nextTorrents;
    selectedTorrentIds.value = selectedTorrentIds.value.filter((torrentId) =>
      nextTorrents.some((torrent) => torrent.id === torrentId),
    );
    if (detailTorrentId.value !== undefined && !nextTorrents.some((torrent) => torrent.id === detailTorrentId.value)) {
      detailTorrentId.value = undefined;
    }
    error.value = "";
    refreshFailures.value = 0;
  } catch (cause) {
    if (currentRequest !== requestVersion || id !== downloaderId.value) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
    if (!manual && ++refreshFailures.value >= 3) {
      autoRefreshSuspended.value = true;
      runtimeStore.showSnakebar(t("DownloadServiceManager.autoRefresh.suspended"), { color: "error", timeout: 8000 });
    }
  } finally {
    if (currentRequest === requestVersion) loading.value = false;
    if (manual && currentRequest === requestVersion) scheduleRefresh();
  }
}

async function runOperation(kind: "start" | "stop" | "remove", ids: TorrentId[], removeData = false) {
  if (ids.length === 0 || !canWrite.value) return;
  pendingOperations.value = new Set([...pendingOperations.value, ...ids]);
  try {
    const result: BulkResult =
      kind === "start"
        ? await sendMessage("startDownloadServiceTorrents", { downloaderId: downloaderId.value, torrentIds: ids })
        : kind === "stop"
          ? await sendMessage("stopDownloadServiceTorrents", { downloaderId: downloaderId.value, torrentIds: ids })
          : await sendMessage("removeDownloadServiceTorrents", {
              downloaderId: downloaderId.value,
              torrentIds: ids,
              deleteData: removeData,
            });
    const failed = result.items.filter((item) => !item.success);
    runtimeStore.showSnakebar(
      failed.length === 0
        ? t("DownloadServiceManager.operation.success", { count: result.items.length })
        : t("DownloadServiceManager.operation.partial", {
            success: result.items.length - failed.length,
            failed: failed.length,
          }),
      { color: failed.length === 0 ? "success" : "warning" },
    );
    if (kind === "remove")
      selectedTorrentIds.value = selectedTorrentIds.value.filter(
        (id) => !result.items.some((item) => item.id === id && item.success),
      );
    await refresh(false);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    runtimeStore.showSnakebar(error.value, { color: "error" });
  } finally {
    const pending = new Set(pendingOperations.value);
    ids.forEach((id) => pending.delete(id));
    pendingOperations.value = pending;
  }
}

function confirmDelete() {
  showDeleteDialog.value = false;
  void runOperation("remove", [...selectedTorrentIds.value], deleteData.value);
}

function openDeleteDialog(ids: TorrentId[], removeData = false) {
  selectedTorrentIds.value = [...new Set(ids)];
  deleteData.value = removeData;
  showDeleteDialog.value = true;
}

function showTorrentDetails(torrent: TorrentSummary) {
  detailTorrentId.value = torrent.id;
  detailTab.value = "overview";
}

function onTorrentRowClick(_event: MouseEvent, { item }: { item: TorrentSummary }) {
  showTorrentDetails(item);
}

function getTorrentRowProps({ item }: { item: TorrentSummary }) {
  return {
    onContextmenu: (event: MouseEvent) => openTorrentContextMenu(event, item),
  };
}

function openTorrentContextMenu(event: MouseEvent, torrent: TorrentSummary) {
  event.preventDefault();
  showTorrentDetails(torrent);
  contextMenuTorrent.value = torrent;
  contextMenuPosition.value = [event.clientX, event.clientY];
  showTorrentContextMenu.value = true;
}

function runContextMenuOperation(kind: "start" | "stop" | "remove" | "removeWithData" | "location") {
  const torrent = contextMenuTorrent.value;
  showTorrentContextMenu.value = false;
  if (!torrent) return;
  if (kind === "location") {
    locationTorrent.value = torrent;
    torrentLocation.value = torrent.savePath;
    moveTorrentData.value = true;
    showTorrentLocationDialog.value = true;
    return;
  }
  if (kind === "remove") {
    openDeleteDialog([torrent.id]);
    return;
  }
  if (kind === "removeWithData") {
    openDeleteDialog([torrent.id], true);
    return;
  }
  void runOperation(kind, [torrent.id]);
}

async function saveTorrentLocation() {
  const torrent = locationTorrent.value;
  const location = torrentLocation.value.trim();
  if (!torrent || !location) {
    runtimeStore.showSnakebar(t("DownloadServiceManager.location.required"), { color: "error" });
    return;
  }

  updatingTorrentLocation.value = true;
  pendingOperations.value = new Set([...pendingOperations.value, torrent.id]);
  try {
    const updated = await sendMessage("setDownloadServiceTorrentLocation", {
      downloaderId: downloaderId.value,
      torrentId: torrent.id,
      location,
      move: moveTorrentData.value,
    });
    if (!updated) throw new Error("Download service did not confirm the torrent location update.");
    showTorrentLocationDialog.value = false;
    await refresh(false);
    runtimeStore.showSnakebar(t("DownloadServiceManager.location.success"), { color: "success" });
  } catch (cause) {
    runtimeStore.showSnakebar(t("DownloadServiceManager.location.failed"), { color: "error" });
    console.error("[download-service-manager] Failed to set torrent location");
  } finally {
    const pending = new Set(pendingOperations.value);
    pending.delete(torrent.id);
    pendingOperations.value = pending;
    updatingTorrentLocation.value = false;
  }
}

function stateColor(state: TorrentSummary["state"]) {
  return {
    downloading: "blue",
    seeding: "green",
    paused: "grey",
    queued: "orange",
    checking: "cyan",
    error: "red",
    unknown: "grey",
  }[state];
}

function stateLabel(state: TorrentSummary["state"]) {
  return t(`MyClient.state.${state}`);
}

function filePriorityLabel(priority: number) {
  if (priority > 0) return t("DownloadServiceManager.detail.filePriority.high");
  if (priority < 0) return t("DownloadServiceManager.detail.filePriority.low");
  return t("DownloadServiceManager.detail.filePriority.normal");
}

async function loadTorrentFiles(torrentId?: TorrentId) {
  const request = ++filesRequestVersion;
  const id = downloaderId.value;
  torrentFiles.value = [];
  filesError.value = "";
  if (torrentId === undefined || !id) {
    filesLoading.value = false;
    return;
  }

  filesLoading.value = true;
  try {
    const files = await sendMessage("getDownloadServiceTorrentFiles", { downloaderId: id, torrentId });
    if (request !== filesRequestVersion || id !== downloaderId.value || selectedTorrent.value?.id !== torrentId) return;
    torrentFiles.value = files;
  } catch (cause) {
    if (request !== filesRequestVersion || id !== downloaderId.value || selectedTorrent.value?.id !== torrentId) return;
    filesError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (request === filesRequestVersion) filesLoading.value = false;
  }
}

watch(
  downloaderId,
  () => {
    requestVersion += 1;
    clearRefreshTimer();
    overview.value = undefined;
    torrents.value = [];
    selectedTorrentIds.value = [];
    detailTorrentId.value = undefined;
    pendingOperations.value = new Set();
    filesRequestVersion += 1;
    torrentFiles.value = [];
    filesError.value = "";
    filesLoading.value = false;
    error.value = "";
    autoRefreshSuspended.value = false;
    void refresh();
  },
  { immediate: true },
);

watch([autoRefreshEnabled, refreshInterval], scheduleRefresh);
watch(
  () => selectedTorrent.value?.id,
  (torrentId) => {
    void loadTorrentFiles(torrentId);
  },
);
watch(
  () => configStore.downloadServiceManager,
  (settings) => {
    autoRefreshEnabled.value = settings.autoRefreshEnabled;
    refreshInterval.value = settings.refreshInterval;
  },
  { deep: true, immediate: true },
);
onUnmounted(() => {
  requestVersion += 1;
  filesRequestVersion += 1;
  clearRefreshTimer();
});
</script>

<template>
  <v-container fluid class="download-service-manager">
    <div class="manager-header">
      <v-btn
        :title="t('common.back')"
        icon="mdi-arrow-left"
        variant="text"
        class="back-button"
        @click="router.push({ name: 'SetDownloader' })"
      />
      <div class="service-identity">
        <h1>{{ t("DownloadServiceManager.title", { name: downloader?.name ?? downloaderId }) }}</h1>
        <span>
          {{ downloader?.type ?? t("DownloadServiceManager.missing") }}
        </span>
      </div>
      <div class="service-meta" aria-live="polite">
        <v-icon icon="mdi-circle" size="10" :color="error ? 'error' : overview ? 'success' : 'grey'" />
        <span>{{ error ? t("MyClient.state.error") : overview ? t("common.success") : t("common.working") }}</span>
      </div>
    </div>

    <v-alert
      v-if="!downloader || !downloader.enabled || downloader.type !== 'Transmission'"
      type="warning"
      class="manager-alert"
    >
      {{
        !downloader
          ? t("DownloadServiceManager.missing")
          : !downloader.enabled
            ? t("DownloadServiceManager.disabled")
            : t("DownloadServiceManager.unsupported")
      }}
      <template #append
        ><v-btn
          :text="t('DownloadServiceManager.backToSettings')"
          variant="text"
          @click="router.push({ name: 'SetDownloader' })"
      /></template>
    </v-alert>
    <v-alert v-else-if="error" type="error" variant="tonal" class="manager-alert" :text="error">
      <template #append
        ><v-btn :text="t('DownloadServiceManager.refresh')" variant="text" @click="refresh()"
      /></template>
    </v-alert>

    <section class="service-overview" aria-live="polite">
      <div class="overview-version">
        <span>{{ t("common.version") }}</span
        ><strong>{{ overview?.version ?? "-" }}</strong>
      </div>
      <div class="overview-metric is-download">
        <span>{{ t("DownloadServiceManager.overview.downloadSpeed") }}</span
        ><strong>{{ formatSize(overview?.downloadSpeed ?? 0) }}/s</strong>
      </div>
      <div class="overview-metric is-upload">
        <span>{{ t("DownloadServiceManager.overview.uploadSpeed") }}</span
        ><strong>{{ formatSize(overview?.uploadSpeed ?? 0) }}/s</strong>
      </div>
      <div class="overview-metric">
        <span>{{ t("DownloadServiceManager.overview.sessionDownloaded") }}</span
        ><strong>{{ formatSize(overview?.sessionDownloaded ?? 0) }}</strong>
      </div>
      <div class="overview-metric">
        <span>{{ t("DownloadServiceManager.overview.sessionUploaded") }}</span
        ><strong>{{ formatSize(overview?.sessionUploaded ?? 0) }}</strong>
      </div>
      <div class="overview-count">
        <strong>{{ overview?.torrentCount ?? "-" }}</strong
        ><span>{{ t("common.count") }}</span>
      </div>
    </section>

    <section class="torrent-browser">
      <aside class="torrent-filter-panel" :aria-label="t('DownloadServiceManager.filters.title')">
        <v-list density="compact" nav class="filter-list">
          <v-list-item
            v-for="filter in statusFilters"
            :key="filter.key"
            :active="activeFilter === filter.key"
            @click="activeFilter = filter.key"
          >
            <template #prepend><v-icon :icon="filter.icon" :color="filter.color" size="16" /></template>
            <v-list-item-title>{{ filter.label }}</v-list-item-title>
            <template #append
              ><span class="filter-count">{{ filter.count }}</span></template
            >
          </v-list-item>
        </v-list>
        <v-divider />
        <v-list v-if="folderFilters.length" density="compact" nav class="filter-list">
          <v-list-subheader>{{ t("DownloadServiceManager.filters.folders") }}</v-list-subheader>
          <v-list-item
            v-for="filter in folderFilters"
            :key="filter.value"
            :active="activeFilter === `folder:${filter.value}`"
            @click="activeFilter = `folder:${filter.value}`"
          >
            <template #prepend><v-icon icon="mdi-folder" color="warning" size="16" /></template>
            <v-list-item-title class="filter-label">{{ filter.value }}</v-list-item-title>
            <template #append
              ><span class="filter-count">{{ filter.count }}</span></template
            >
          </v-list-item>
        </v-list>
      </aside>

      <v-card class="torrent-workspace" flat>
        <section class="torrent-list-pane">
          <v-toolbar density="comfortable" class="workspace-toolbar">
            <v-btn
              :disabled="!canWrite || selectedTorrentIds.length === 0"
              :title="t('DownloadServiceManager.start')"
              color="success"
              icon="mdi-play"
              @click="runOperation('start', [...selectedTorrentIds])"
            />
            <v-btn
              :disabled="!canWrite || selectedTorrentIds.length === 0"
              :title="t('DownloadServiceManager.stop')"
              color="warning"
              icon="mdi-pause"
              @click="runOperation('stop', [...selectedTorrentIds])"
            />
            <v-btn
              :disabled="!canWrite || selectedTorrentIds.length === 0"
              :title="t('DownloadServiceManager.remove')"
              color="error"
              icon="mdi-delete"
              @click="openDeleteDialog([...selectedTorrentIds])"
            />
            <v-divider vertical class="mx-2" />
            <v-btn
              :loading="loading"
              :title="t('DownloadServiceManager.refresh')"
              icon="mdi-refresh"
              variant="text"
              @click="refresh()"
            />
            <v-btn
              :color="autoRefreshEnabled ? 'primary' : undefined"
              :title="t('DownloadServiceManager.settings.title')"
              :icon="autoRefreshEnabled ? 'mdi-cog' : 'mdi-cog-outline'"
              variant="text"
              @click="openSettingsDialog"
            />
            <v-menu :close-on-content-click="false">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  :title="t('DownloadServiceManager.columns')"
                  icon="mdi-table-column"
                  variant="text"
                />
              </template>
              <v-list min-width="220" class="column-menu pa-2">
                <v-list-subheader>{{ t("DownloadServiceManager.columns") }}</v-list-subheader>
                <v-list-item
                  v-for="header in fullHeaders.filter((item) => !item.props?.required)"
                  :key="String(header.key)"
                >
                  <v-checkbox
                    v-model="selectedColumns"
                    :label="header.title"
                    :value="String(header.key)"
                    density="compact"
                    hide-details
                  />
                </v-list-item>
              </v-list>
            </v-menu>
            <v-spacer />
            <v-text-field
              v-model="search"
              :label="t('DownloadServiceManager.search')"
              prepend-inner-icon="mdi-magnify"
              clearable
              density="compact"
              hide-details
              max-width="340"
              variant="outlined"
              class="torrent-search mr-3"
            />
          </v-toolbar>
          <v-data-table
            v-model="selectedTorrentIds"
            :headers="headers"
            :items="filteredTorrents"
            item-value="id"
            :row-props="getTorrentRowProps"
            show-select
            :loading="loading"
            class="torrent-table"
            hover
            @click:row="onTorrentRowClick"
          >
            <template #item.name="{ item }">
              <div class="torrent-name">{{ item.name }}</div>
            </template>
            <template #item.label="{ item }"
              ><v-chip v-if="item.label" size="small" label>{{ item.label }}</v-chip
              ><span v-else>-</span></template
            >
            <template #item.totalSize="{ item }"
              ><span class="numeric-cell">{{ formatSize(item.totalSize) }}</span></template
            >
            <template #item.progress="{ item }">
              <div class="progress-cell">
                <span>{{ item.progress.toFixed(1) }}%</span
                ><v-progress-linear :model-value="item.progress" color="primary" height="3" rounded />
              </div>
            </template>
            <template #item.state="{ item }"
              ><v-chip size="small" label :color="stateColor(item.state)">{{
                stateLabel(item.state)
              }}</v-chip></template
            >
            <template #item.uploadSpeed="{ item }"
              ><span class="numeric-cell is-upload">{{ formatSize(item.uploadSpeed) }}/s</span></template
            >
            <template #item.downloadSpeed="{ item }"
              ><span class="numeric-cell is-download">{{ formatSize(item.downloadSpeed) }}/s</span></template
            >
            <template #item.totalUploaded="{ item }"
              ><span class="numeric-cell">{{ formatSize(item.totalUploaded) }}</span></template
            >
            <template #item.totalDownloaded="{ item }"
              ><span class="numeric-cell">{{ formatSize(item.totalDownloaded) }}</span></template
            >
            <template #item.ratio="{ item }"
              ><span class="numeric-cell">{{ item.ratio.toFixed(2) }}</span></template
            >
            <template #item.savePath="{ item }"
              ><span class="torrent-path" :title="item.savePath">{{ item.savePath }}</span></template
            >
            <template #item.addedAt="{ item }"
              ><span class="added-at">{{ formatDate(item.addedAt * 1000) }}</span></template
            >
            <template #item.action="{ item }">
              <div class="torrent-actions">
                <v-btn
                  v-if="item.state === 'paused' || item.state === 'error'"
                  :disabled="!canWrite || pendingOperations.has(item.id)"
                  :title="t('DownloadServiceManager.start')"
                  icon="mdi-play"
                  size="small"
                  color="success"
                  variant="text"
                  @click="runOperation('start', [item.id])"
                /><v-btn
                  v-else-if="item.state === 'downloading' || item.state === 'seeding'"
                  :disabled="!canWrite || pendingOperations.has(item.id)"
                  :title="t('DownloadServiceManager.stop')"
                  icon="mdi-pause"
                  size="small"
                  variant="text"
                  @click="runOperation('stop', [item.id])"
                /><v-btn
                  :disabled="!canWrite || pendingOperations.has(item.id)"
                  :title="t('DownloadServiceManager.remove')"
                  icon="mdi-delete"
                  size="small"
                  color="error"
                  variant="text"
                  @click="openDeleteDialog([item.id])"
                />
              </div>
            </template>
          </v-data-table>
          <v-menu
            v-model="showTorrentContextMenu"
            :target="contextMenuPosition"
            location="end"
            min-width="160"
          >
            <v-list density="compact" nav>
              <v-list-item
                :disabled="!canWrite || !contextMenuTorrent"
                prepend-icon="mdi-play"
                @click="runContextMenuOperation('start')"
              >
                <v-list-item-title>{{ t("DownloadServiceManager.start") }}</v-list-item-title>
              </v-list-item>
              <v-list-item
                :disabled="!canWrite || !contextMenuTorrent"
                prepend-icon="mdi-pause"
                @click="runContextMenuOperation('stop')"
              >
                <v-list-item-title>{{ t("DownloadServiceManager.stop") }}</v-list-item-title>
              </v-list-item>
              <v-list-item
                :disabled="!canWrite || !contextMenuTorrent"
                base-color="error"
                prepend-icon="mdi-delete-outline"
                @click="runContextMenuOperation('remove')"
              >
                <v-list-item-title>{{ t("DownloadServiceManager.remove") }}</v-list-item-title>
              </v-list-item>
              <v-list-item
                :disabled="!canWrite || !contextMenuTorrent"
                base-color="error"
                prepend-icon="mdi-delete-forever-outline"
                @click="runContextMenuOperation('removeWithData')"
              >
                <v-list-item-title>{{ t("DownloadServiceManager.removeWithData") }}</v-list-item-title>
              </v-list-item>
              <v-divider class="my-1" />
              <v-list-item
                :disabled="!canWrite || !contextMenuTorrent"
                prepend-icon="mdi-folder-move-outline"
                @click="runContextMenuOperation('location')"
              >
                <v-list-item-title>{{ t("DownloadServiceManager.location.action") }}</v-list-item-title>
              </v-list-item>
            </v-list>
          </v-menu>
        </section>

        <section class="torrent-detail-pane">
          <header class="detail-header">
            <div class="detail-title" :title="selectedTorrent?.name">
              <v-icon icon="mdi-information-outline" size="17" />
              <span>{{ selectedTorrent?.name ?? t("DownloadServiceManager.detail.none") }}</span>
            </div>
            <v-tabs v-if="selectedTorrent" v-model="detailTab" density="compact" class="detail-tabs">
              <v-tab value="overview">{{ t("DownloadServiceManager.detail.overview") }}</v-tab>
              <v-tab value="files">{{ t("DownloadServiceManager.detail.files") }}</v-tab>
              <v-tab value="trackers">{{ t("DownloadServiceManager.detail.trackers") }}</v-tab>
            </v-tabs>
          </header>

          <div v-if="selectedTorrent" class="detail-body">
            <dl v-if="detailTab === 'overview'" class="torrent-detail-grid">
              <div>
                <dt>{{ t("DownloadServiceManager.detail.state") }}</dt>
                <dd>
                  <v-chip size="x-small" label :color="stateColor(selectedTorrent.state)">
                    {{ stateLabel(selectedTorrent.state) }}
                  </v-chip>
                </dd>
              </div>
              <div>
                <dt>{{ t("DownloadServiceManager.detail.progress") }}</dt>
                <dd>{{ selectedTorrent.progress.toFixed(1) }}%</dd>
              </div>
              <div>
                <dt>{{ t("DownloadServiceManager.detail.size") }}</dt>
                <dd>{{ formatSize(selectedTorrent.totalSize) }}</dd>
              </div>
              <div>
                <dt>{{ t("DownloadServiceManager.detail.ratio") }}</dt>
                <dd>{{ selectedTorrent.ratio.toFixed(2) }}</dd>
              </div>
              <div>
                <dt>{{ t("DownloadServiceManager.detail.downloadSpeed") }}</dt>
                <dd class="is-download">{{ formatSize(selectedTorrent.downloadSpeed) }}/s</dd>
              </div>
              <div>
                <dt>{{ t("DownloadServiceManager.detail.uploadSpeed") }}</dt>
                <dd class="is-upload">{{ formatSize(selectedTorrent.uploadSpeed) }}/s</dd>
              </div>
              <div class="detail-span-2">
                <dt>{{ t("DownloadServiceManager.detail.savePath") }}</dt>
                <dd :title="selectedTorrent.savePath" class="detail-ellipsis">{{ selectedTorrent.savePath }}</dd>
              </div>
              <div>
                <dt>{{ t("DownloadServiceManager.detail.addedAt") }}</dt>
                <dd>{{ formatDate(selectedTorrent.addedAt * 1000) }}</dd>
              </div>
            </dl>
            <div v-else-if="detailTab === 'files'" class="detail-files">
              <div v-if="filesLoading" class="detail-empty">
                <v-progress-circular indeterminate color="primary" size="20" width="2" />
              </div>
              <v-alert v-else-if="filesError" type="error" density="compact" variant="tonal" :text="filesError" />
              <div v-else-if="torrentFiles.length === 0" class="detail-empty">
                {{ t("DownloadServiceManager.detail.noFiles") }}
              </div>
              <v-table v-else density="compact" fixed-header class="torrent-files-table">
                <thead>
                  <tr>
                    <th>{{ t("DownloadServiceManager.detail.fileName") }}</th>
                    <th class="text-end">{{ t("DownloadServiceManager.detail.fileSize") }}</th>
                    <th>{{ t("DownloadServiceManager.detail.fileProgress") }}</th>
                    <th class="text-end">{{ t("DownloadServiceManager.detail.filePriority.title") }}</th>
                    <th class="text-center">{{ t("DownloadServiceManager.detail.fileWanted") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="file in torrentFiles" :key="file.name">
                    <td><span class="file-name" :title="file.name">{{ file.name }}</span></td>
                    <td class="text-end"><span class="numeric-cell">{{ formatSize(file.length) }}</span></td>
                    <td>
                      <div class="file-progress">
                        <span>{{ formatSize(file.bytesCompleted) }} / {{ formatSize(file.length) }}</span>
                        <v-progress-linear
                          :model-value="file.length ? (file.bytesCompleted / file.length) * 100 : 0"
                          color="primary"
                          height="3"
                          rounded
                        />
                      </div>
                    </td>
                    <td class="text-end">{{ filePriorityLabel(file.priority) }}</td>
                    <td class="text-center">
                      <v-icon
                        :icon="file.wanted ? 'mdi-check-circle' : 'mdi-minus-circle-outline'"
                        :color="file.wanted ? 'success' : undefined"
                        :title="file.wanted ? t('DownloadServiceManager.detail.fileWantedYes') : t('DownloadServiceManager.detail.fileWantedNo')"
                        size="17"
                      />
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </div>
            <v-list v-else density="compact" class="detail-trackers">
              <v-list-item v-for="tracker in selectedTorrent.trackers" :key="tracker" :title="tracker">
                <template #prepend><v-icon icon="mdi-access-point" size="16" /></template>
                <v-list-item-title>{{ tracker }}</v-list-item-title>
              </v-list-item>
              <v-list-item v-if="selectedTorrent.trackers.length === 0">
                <v-list-item-title>{{ t("DownloadServiceManager.detail.noTrackers") }}</v-list-item-title>
              </v-list-item>
            </v-list>
          </div>
        </section>
      </v-card>
    </section>

    <v-dialog v-model="showSettingsDialog" max-width="420">
      <v-card>
        <v-card-title>{{ t("DownloadServiceManager.settings.title") }}</v-card-title>
        <v-card-text>
          <v-switch
            v-model="settingsDraft.autoRefreshEnabled"
            :label="t('DownloadServiceManager.autoRefresh.enable')"
            color="primary"
            hide-details
          />
          <v-number-input
            v-model="settingsDraft.refreshInterval"
            :disabled="!settingsDraft.autoRefreshEnabled"
            :min="1"
            :max="3600"
            :label="t('DownloadServiceManager.autoRefresh.interval')"
            density="comfortable"
            hide-details
            class="mt-4"
          />
          <v-text-field
            v-model="defaultDownloadDirectory"
            :label="t('DownloadServiceManager.settings.defaultDownloadDirectory')"
            :hint="t('DownloadServiceManager.settings.defaultDownloadDirectoryHint')"
            :loading="defaultDownloadDirectoryLoading"
            :disabled="defaultDownloadDirectoryLoading || settingsSaving"
            prepend-inner-icon="mdi-folder-outline"
            density="comfortable"
            persistent-hint
            class="mt-4"
          />
          <v-alert v-if="autoRefreshSuspended" type="error" density="compact" class="mt-4">
            {{ t("DownloadServiceManager.autoRefresh.suspended") }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn :disabled="settingsSaving" :text="t('common.dialog.cancel')" @click="showSettingsDialog = false" />
          <v-btn
            :disabled="defaultDownloadDirectoryLoading"
            :loading="settingsSaving"
            :text="t('common.save')"
            color="primary"
            @click="saveSettings"
          />
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="showTorrentLocationDialog" max-width="620">
      <v-card>
        <v-card-title>{{ t("DownloadServiceManager.location.title") }}</v-card-title>
        <v-card-text>
          <div class="text-body-2 text-medium-emphasis mb-4 text-truncate" :title="locationTorrent?.name">
            {{ locationTorrent?.name }}
          </div>
          <v-text-field
            v-model="torrentLocation"
            :disabled="updatingTorrentLocation"
            :label="t('DownloadServiceManager.location.path')"
            prepend-inner-icon="mdi-folder-outline"
            autofocus
          />
          <v-checkbox
            v-model="moveTorrentData"
            :disabled="updatingTorrentLocation"
            :label="t('DownloadServiceManager.location.moveData')"
            color="primary"
            density="compact"
            hide-details
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn :disabled="updatingTorrentLocation" :text="t('common.dialog.cancel')" @click="showTorrentLocationDialog = false" />
          <v-btn
            :loading="updatingTorrentLocation"
            :text="t('common.dialog.ok')"
            color="primary"
            @click="saveTorrentLocation"
          />
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="showDeleteDialog" max-width="420">
      <v-card
        ><v-card-title>{{ t("DownloadServiceManager.delete.title") }}</v-card-title
        ><v-card-text
          >{{ t("DownloadServiceManager.delete.text", { count: selectedTorrentIds.length })
          }}<v-checkbox
            v-model="deleteData"
            :label="t('DownloadServiceManager.delete.data')"
            color="error"
            hide-details
            class="mt-3" /></v-card-text
        ><v-card-actions
          ><v-spacer /><v-btn :text="t('common.dialog.cancel')" @click="showDeleteDialog = false" /><v-btn
            :text="t('common.remove')"
            color="error"
            @click="confirmDelete" /></v-card-actions
      ></v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped lang="scss">
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · macrostructure: Index-First · tone: modern-minimal · theme: Quiet · anchor hue: blue */
.download-service-manager {
  --manager-border: rgb(var(--v-theme-on-surface) / 0.14);
  --manager-border-subtle: rgb(var(--v-theme-on-surface) / 0.08);
  --manager-row-divider: rgb(var(--v-theme-on-surface) / 0.045);
  --manager-torrent-row-divider: rgb(var(--v-theme-on-surface) / 0.015);
  --manager-muted: rgb(var(--v-theme-on-surface) / 0.62);
  --manager-surface: rgb(var(--v-theme-surface));
  --manager-surface-muted: rgb(var(--v-theme-on-surface) / 0.045);
  --manager-sidebar: rgb(var(--v-theme-on-surface) / 0.065);
  --manager-active: rgb(var(--v-theme-primary) / 0.12);
  --manager-focus: rgb(var(--v-theme-primary));
  --manager-ease: cubic-bezier(0.16, 1, 0.3, 1);
  max-width: 1760px;
  margin-inline: auto;
  padding: clamp(16px, 2vw, 28px) clamp(16px, 2.25vw, 36px) 36px;
}

.manager-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  margin-bottom: 14px;
}

.back-button {
  flex: 0 0 auto;
  color: var(--manager-muted);
}
.service-identity {
  flex: 1 1 auto;
  min-width: 0;
}
.service-identity h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}
.service-identity span,
.service-meta {
  color: var(--manager-muted);
  font-size: 11px;
}
.service-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 5px 8px;
  border: 1px solid var(--manager-border-subtle);
  background: var(--manager-surface-muted);
  white-space: nowrap;
}
.manager-alert {
  margin-bottom: 14px;
}

.service-overview {
  display: grid;
  grid-template-columns: minmax(180px, 1.55fr) repeat(4, minmax(120px, 0.9fr)) minmax(92px, 0.5fr);
  margin: 0 0 20px;
  border-block: 1px solid var(--manager-border);
  background: var(--manager-surface-muted);
}

.overview-version,
.overview-metric,
.overview-count {
  min-width: 0;
  min-height: 68px;
  padding: 11px 16px;
  border-inline-end: 1px solid var(--manager-border-subtle);
}
.overview-version span,
.overview-metric span {
  display: block;
  color: var(--manager-muted);
  font-size: 11px;
}
.overview-version strong,
.overview-metric strong {
  display: block;
  overflow: hidden;
  margin-top: 5px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.overview-metric.is-download strong {
  color: rgb(var(--v-theme-primary));
}
.overview-metric.is-upload strong {
  color: rgb(var(--v-theme-success));
}
.overview-count {
  display: grid;
  place-content: center;
  border-inline-end: 0;
  background: var(--manager-surface);
  text-align: center;
}
.overview-count strong {
  font-size: 22px;
  line-height: 1;
}
.overview-count span {
  margin-top: 4px;
  color: var(--manager-muted);
  font-size: 12px;
}

.torrent-browser {
  display: grid;
  grid-template-columns: minmax(210px, 270px) minmax(0, 1fr);
  height: min(720px, calc(100dvh - 244px));
  min-height: 560px;
  overflow: hidden;
  border: 1px solid var(--manager-border);
  background: var(--manager-surface);
}
.torrent-filter-panel {
  min-width: 0;
  overflow: auto;
  border-inline-end: 1px solid var(--manager-border);
  background: var(--manager-sidebar);
}
.filter-list {
  padding-block: 8px;
}
.filter-list :deep(.v-list-item) {
  min-height: 32px;
  margin-inline: 6px;
  padding-inline: 8px;
  border-inline-start: 2px solid transparent;
  border-radius: 0;
  transition:
    background-color 150ms var(--manager-ease),
    border-color 150ms var(--manager-ease);
}
.filter-list :deep(.v-list-item--active) {
  border-inline-start-color: var(--manager-focus);
  background: var(--manager-active);
}
.filter-list :deep(.v-list-item__prepend) {
  margin-inline-end: 8px;
}
.filter-list :deep(.v-list-subheader) {
  min-height: 30px;
  padding-inline: 14px;
  color: var(--manager-muted);
  font-size: 11px;
  font-weight: 600;
}
.filter-label,
.filter-count {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filter-count {
  min-width: 2ch;
  margin-inline-start: 8px;
  color: var(--manager-muted);
  font-variant-numeric: tabular-nums;
  text-align: end;
}
.torrent-workspace {
  display: grid;
  grid-template-rows: minmax(0, 1fr) minmax(174px, 31%);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}
.torrent-list-pane {
  display: flex;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}
.workspace-toolbar {
  min-height: 54px;
  gap: 4px;
  padding-inline: 12px;
  border-bottom: 1px solid var(--manager-border);
  background: var(--manager-surface);
}
.workspace-toolbar :deep(.v-btn) {
  min-width: 36px;
}
.torrent-search {
  min-width: min(260px, 32vw);
}
.torrent-search :deep(.v-field) {
  border-radius: 2px;
  background: var(--manager-surface-muted);
}
.column-menu :deep(.v-list-item) {
  min-height: 34px;
  padding-inline: 6px;
}
.column-menu :deep(.v-selection-control) {
  min-height: 30px;
}

.torrent-table :deep(.v-table__wrapper) {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: auto;
  overflow-y: auto;
}
.torrent-table {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}
.torrent-table :deep(.v-data-table-footer) {
  flex: 0 0 auto;
  border-top: 1px solid var(--manager-border-subtle);
}
.torrent-table :deep(table) {
  min-width: 1280px;
  table-layout: fixed;
}
.torrent-table :deep(.v-data-table-header__content) {
  color: var(--manager-muted);
  font-size: 11px;
  font-weight: 600;
}
.torrent-table :deep(.v-data-table__th) {
  height: 42px !important;
  border-bottom-color: var(--manager-border) !important;
  background: var(--manager-surface-muted);
}
.torrent-table :deep(.v-data-table__td),
.torrent-table :deep(.v-data-table__th) {
  padding-inline: 10px;
}
.torrent-table :deep(.v-data-table__td) {
  height: 52px;
  border-bottom: 1px solid var(--manager-torrent-row-divider) !important;
  font-size: 13px;
}
.torrent-table :deep(.v-data-table__td:first-child),
.torrent-table :deep(.v-data-table__th:first-child) {
  padding-inline: 14px 5px;
}
.torrent-name {
  overflow: hidden;
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.torrent-path {
  overflow: hidden;
  color: var(--manager-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.numeric-cell,
.added-at {
  display: block;
  white-space: nowrap;
}
.numeric-cell.is-download {
  color: rgb(var(--v-theme-primary));
}
.numeric-cell.is-upload {
  color: rgb(var(--v-theme-success));
}
.progress-cell {
  display: grid;
  gap: 4px;
  min-width: 60px;
}
.progress-cell span {
  font-variant-numeric: tabular-nums;
}
.torrent-actions {
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  white-space: nowrap;
}
.torrent-detail-pane {
  display: grid;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  border-top: 1px solid var(--manager-border);
  background: var(--manager-surface-muted);
}
.detail-header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
  padding-inline: 14px;
  border-bottom: 1px solid var(--manager-border-subtle);
  background: var(--manager-surface);
}
.detail-title {
  display: inline-flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 7px;
  color: var(--manager-muted);
  font-size: 12px;
  font-weight: 600;
}
.detail-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-tabs {
  flex: 0 0 auto;
  min-width: 0;
}
.detail-tabs :deep(.v-btn) {
  min-width: 0;
  padding-inline: 10px;
  font-size: 12px;
  white-space: nowrap;
}
.detail-body {
  min-height: 0;
  overflow: auto;
}
.detail-files {
  min-height: 100%;
}
.detail-empty {
  display: grid;
  min-height: 112px;
  place-items: center;
  padding: 16px;
  color: var(--manager-muted);
  font-size: 12px;
}
.torrent-files-table {
  min-width: 720px;
  background: transparent;
}
.torrent-files-table :deep(th) {
  height: 32px;
  color: var(--manager-muted);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.torrent-files-table :deep(td) {
  height: 38px;
  border-bottom-color: var(--manager-row-divider) !important;
  font-size: 12px;
}
.torrent-files-table :deep(th:first-child),
.torrent-files-table :deep(td:first-child) {
  width: 46%;
}
.file-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-progress {
  display: grid;
  min-width: 150px;
  gap: 3px;
  color: var(--manager-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.torrent-detail-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  margin: 0;
}
.torrent-detail-grid > div {
  min-width: 0;
  padding: 10px 14px;
  border-right: 1px solid var(--manager-border-subtle);
  border-bottom: 1px solid var(--manager-border-subtle);
}
.torrent-detail-grid dt {
  color: var(--manager-muted);
  font-size: 11px;
}
.torrent-detail-grid dd {
  min-width: 0;
  margin: 4px 0 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.torrent-detail-grid dd.is-download {
  color: rgb(var(--v-theme-primary));
}
.torrent-detail-grid dd.is-upload {
  color: rgb(var(--v-theme-success));
}
.detail-span-2 {
  grid-column: span 2;
}
.detail-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-trackers {
  padding-block: 4px;
  background: transparent;
}
.detail-trackers :deep(.v-list-item) {
  min-height: 30px;
  padding-inline: 14px;
}
.detail-trackers :deep(.v-list-item__prepend) {
  margin-inline-end: 8px;
}
.detail-trackers :deep(.v-list-item-title) {
  overflow: hidden;
  color: var(--manager-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.torrent-table :deep(.v-btn:focus-visible),
.workspace-toolbar :deep(.v-btn:focus-visible),
.back-button:focus-visible {
  outline: 2px solid var(--manager-focus);
  outline-offset: 2px;
}

@media (max-width: 959px) {
  .service-overview {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .torrent-browser {
    grid-template-columns: minmax(176px, 210px) minmax(0, 1fr);
    height: min(680px, calc(100dvh - 250px));
    min-height: 520px;
  }
  .overview-count {
    border-top: 1px solid var(--manager-border);
  }
}

@media (max-width: 639px) {
  .download-service-manager {
    padding: 12px 12px 24px;
    overflow-x: clip;
  }
  .manager-header {
    margin-bottom: 12px;
  }
  .service-meta {
    display: none;
  }
  .service-identity h1 {
    font-size: 14px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .manager-alert :deep(.v-alert__append) {
    display: none;
  }
  .service-overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .torrent-browser {
    grid-template-columns: 1fr;
    height: auto;
    min-height: 0;
  }
  .torrent-filter-panel {
    max-height: 240px;
    border-inline-end: 0;
    border-bottom: 1px solid var(--manager-border);
  }
  .torrent-workspace {
    grid-template-rows: auto auto;
  }
  .torrent-list-pane {
    min-height: 360px;
  }
  .torrent-detail-pane {
    min-height: 216px;
  }
  .torrent-detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .overview-version {
    grid-column: span 2;
  }
  .overview-version {
    border-bottom: 1px solid var(--manager-border);
    border-inline-end: 0;
  }
  .overview-metric:nth-child(3),
  .overview-count {
    border-inline-end: 0;
  }
  .overview-metric:nth-child(4),
  .overview-metric:nth-child(5),
  .overview-count {
    border-top: 1px solid var(--manager-border);
  }
  .workspace-toolbar {
    flex-wrap: wrap;
    padding: 8px;
  }
  .torrent-search {
    order: 3;
    width: 100%;
    margin-inline-start: 0 !important;
  }
}

@media (hover: hover) and (pointer: fine) {
  .filter-list :deep(.v-list-item:hover:not(.v-list-item--active)) {
    background: rgb(var(--v-theme-on-surface) / 0.045);
  }
  .torrent-table :deep(.v-data-table__tr) {
    transition: background-color 150ms var(--manager-ease);
  }
  .torrent-table :deep(.v-data-table__tr:hover) {
    background: rgb(var(--v-theme-primary) / 0.05) !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .torrent-table :deep(.v-data-table__tr) {
    transition: none;
  }
}
</style>

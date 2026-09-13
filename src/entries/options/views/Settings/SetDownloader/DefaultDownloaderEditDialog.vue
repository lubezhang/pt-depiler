<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import type { IDefaultDownloaderConfig, TDownloaderKey } from "@/shared/types/storages/metadata.ts";
import { useResetableRef } from "@/options/directives/useResetableRef.ts";
import { getDownloaderIcon } from "@ptd/downloader";

const showDialog = defineModel<boolean>();

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();
const isSaving = ref(false);

const { ref: defaultDownloaderConfig, reset: resetDefaultDownloaderConfig } = useResetableRef<
  Required<IDefaultDownloaderConfig>
>(() => ({
  id: "",
  folder: "",
  tags: "",
}));

const { ref: suggests, reset: resetSuggestions } = useResetableRef<{ folder: string[]; tags: string[] }>(
  () => ({ folder: [], tags: [] }),
  { shallow: true },
);

function updateDefaultDownloaderInput(downloaderId: TDownloaderKey, clean: boolean = true) {
  // 如果切换了下载器，则清空路径和标签
  if (clean) {
    defaultDownloaderConfig.value.folder = "";
    defaultDownloaderConfig.value.tags = "";
  }

  // 加载预设的下载路径和标签
  suggests.value = {
    folder: metadataStore.downloaders?.[downloaderId]?.suggestFolders ?? [],
    tags: metadataStore.downloaders?.[downloaderId]?.suggestTags ?? [],
  };
}

async function saveDefaultDownloader() {
  isSaving.value = true;
  metadataStore.defaultDownloader = defaultDownloaderConfig.value;
  try {
    await metadataStore.$save();
    showDialog.value = false;
  } catch (error) {
    console.error("[pinia] Failed to save the default downloader", error);
    runtimeStore.showSnakebar(error instanceof Error ? error.message : String(error), { color: "error" });
  } finally {
    isSaving.value = false;
  }
}

function enterDialog() {
  // 首先重置选项
  resetDefaultDownloaderConfig();
  resetSuggestions();

  // 如果已经有默认下载器了，则加载它
  if (metadataStore.defaultDownloader?.id) {
    defaultDownloaderConfig.value = { ...metadataStore.defaultDownloader } as Required<IDefaultDownloaderConfig>;
    updateDefaultDownloaderInput(defaultDownloaderConfig.value.id!, false);
  }
}
</script>

<template>
  <v-dialog v-model="showDialog" max-width="600" scrollable @after-enter="enterDialog">
    <v-card>
      <v-card-title class="pa-0">
        <v-toolbar :title="t('SetDownloader.index.editDefaultDownloaderBtn')" color="blue-grey-darken-2">
          <template #append>
            <v-btn icon="mdi-close" @click="showDialog = false" />
          </template>
        </v-toolbar>
      </v-card-title>
      <v-divider />
      <v-card-text>
        <v-form>
          <v-label class="ml-1 mb-1">{{ t("SetDownloader.index.editDefaultDownloaderBtn") }}</v-label>
          <v-autocomplete
            v-model="defaultDownloaderConfig.id"
            :items="metadataStore.getEnabledDownloaders"
            :multiple="false"
            item-value="id"
            @update:model-value="(e) => updateDefaultDownloaderInput(e)"
          >
            <template #selection="{ item: { raw: downloader } }">
              <v-list-item
                :prepend-avatar="getDownloaderIcon(downloader.type)"
                :subtitle="downloader.address"
                :title="downloader.name"
              />
            </template>
            <template #item="{ props, item: { raw: downloader } }">
              <v-list-item
                v-bind="props"
                :prepend-avatar="getDownloaderIcon(downloader.type)"
                :subtitle="downloader.address"
                :title="downloader.name"
              >
              </v-list-item>
            </template>
          </v-autocomplete>

          <!-- 如果用户已经在对应下载器的预设了下载路径和标签，则加载对应的列表 -->
          <v-combobox v-model="defaultDownloaderConfig.folder" :items="suggests.folder" :label="t('SetDownloader.PathAndTag.downloadPath.title')" />
          <v-combobox v-model="defaultDownloaderConfig.tags" :items="suggests.tags" :label="t('SetDownloader.PathAndTag.tags.title')" />
        </v-form>
      </v-card-text>
      <v-divider />
      <v-card-actions>
        <v-spacer />
        <v-btn
          :disabled="isSaving"
          :loading="isSaving"
          color="success"
          prepend-icon="mdi-check-circle-outline"
          variant="text"
          @click="saveDefaultDownloader"
        >
          {{ t("common.dialog.ok") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped lang="scss"></style>

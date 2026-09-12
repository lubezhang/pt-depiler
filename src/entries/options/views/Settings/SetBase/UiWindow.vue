<script setup lang="ts">
import { useI18n } from "vue-i18n";

import { supportTheme } from "@/shared/types.ts";
import { definedLangMetaData } from "@/options/plugins/i18n.ts";

import { useConfigStore } from "@/options/stores/config.ts";

const { t } = useI18n();
const configStore = useConfigStore();
</script>

<template>
  <v-row>
    <v-col md="10" lg="8">
      <!-- 应用语言设置 -->
      <v-select v-model="configStore.lang" :label="t('SetBase.ui.changeLanguage')" :items="definedLangMetaData" />

      <!-- 明亮模式设置 -->
      <v-select v-model="configStore.theme" :label="t('SetBase.ui.displayMode.index')" :items="supportTheme">
        <template #selection="{ item }">
          {{ t("SetBase.ui.displayMode." + item.raw) }}
        </template>

        <template #item="{ item, props }">
          <v-list-item v-bind="props" :title="t('SetBase.ui.displayMode.' + item.raw)" />
        </template>
      </v-select>

      <v-switch
        v-model="configStore.showReleaseNoteOnVersionChange"
        color="success"
        hide-details
        :label="t('SetBase.ui.showReleaseNote')"
      />

      <v-switch
        v-model="configStore.saveTableBehavior"
        color="success"
        hide-details
        :label="t('SetBase.ui.saveTableBehavior')"
      />

      <v-switch
        v-model="configStore.enableTableMultiSort"
        color="success"
        hide-details
        :label="t('SetBase.ui.enableTableMultiSort')"
      >
        <template #append>
          <v-tooltip max-width="400" location="bottom">
            <template v-slot:activator="{ props }">
              <v-icon color="info" icon="mdi-help-circle" v-bind="props" />
            </template>
            {{ t("SetBase.ui.tableMultiSortNote") }}
          </v-tooltip>
        </template>
      </v-switch>

      <v-divider />
    </v-col>
  </v-row>
</template>

<style scoped lang="scss"></style>

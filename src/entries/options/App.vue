<script setup lang="ts">
import { watch, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useLocale as useVuetifyLocal } from "vuetify";

import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { vuetifyLangMap } from "@/options/plugins/vuetify.ts";

import Navigation from "./views/Layout/Navigation.vue";
import Topbar from "./views/Layout/Topbar.vue";
import ReleaseNoteDialog from "./views/Layout/ReleaseNoteDialog.vue";

const { current: currentVuetifyLocal } = useVuetifyLocal();
const { locale: currentVueI18nLocal, t } = useI18n({ useScope: "global" });

const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();

watch(
  () => configStore.lang,
  (newLang) => {
    currentVueI18nLocal.value = newLang; // 修改 vue-i18n 的语言
    currentVuetifyLocal.value = vuetifyLangMap[newLang]; // 修改 vuetify 的语言
  },
  { immediate: true },
);

const showReleaseNoteDialog = ref<boolean>(false);

// 由于App.vue是整个应用的根组件，此时 configStore 等 pinia store 可能还未初始化完成，所以需要监听 $onReady
configStore.$onReady(() => {
  if (configStore.showReleaseNoteOnVersionChange && configStore.version !== __APP_VERSION__) {
    showReleaseNoteDialog.value = true;
  }
});
</script>

<template>
  <v-app id="ptd" :theme="configStore.uiTheme">
    <!-- 顶部工具条 -->
    <Topbar />

    <!-- 导航栏 -->
    <Navigation />

    <v-main id="ptd-main">
      <v-container fluid>
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </v-container>
    </v-main>
  </v-app>

  <ReleaseNoteDialog v-model="showReleaseNoteDialog" />

  <v-snackbar-queue v-model="runtimeStore.uiGlobalSnakebar" closable />
</template>

<style scoped></style>

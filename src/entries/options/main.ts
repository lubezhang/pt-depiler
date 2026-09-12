import { createApp } from "vue";
import axios from "axios";
import App from "./App.vue";

// Tauri 迁移：所有 axios 请求经 tauriAdapter 转发到 Rust ptd_fetch，绕过 webview 跨域限制。
import { tauriAdapter } from "~/extends/axios/tauriAdapter.ts";
axios.defaults.adapter = tauriAdapter;

// 注册业务 handler（单进程本地消息路由）
import "./service/index.ts";

// Vue Plugins
import { vuetifyInstance as vuetify } from "./plugins/vuetify";
import { piniaInstance as pinia } from "./plugins/pinia";
import { routerInstance as router } from "./plugins/router";
import { i18nInstance as i18n } from "./plugins/i18n";
import VueKonva from "vue-konva";

createApp(App).use(pinia).use(i18n).use(router).use(vuetify).use(VueKonva, { prefix: "Vk" }).mount("#app");

import axios from "axios";
import { bootstrapApp } from "./bootstrap.ts";

// Tauri 迁移：所有 axios 请求经 tauriAdapter 转发到 Rust ptd_fetch，绕过 webview 跨域限制。
import { tauriAdapter } from "~/extends/axios/tauriAdapter.ts";
axios.defaults.adapter = tauriAdapter;

void bootstrapApp({
  configureTransport: () => {
    axios.defaults.adapter = tauriAdapter;
  },
}).catch(() => {
  // bootstrapApp 已渲染诊断页并写入结构化日志。
});

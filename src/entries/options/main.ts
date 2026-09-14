import { bootstrapApp } from "./bootstrap.ts";

void bootstrapApp().catch(() => {
  // bootstrapApp 已渲染诊断页并写入结构化日志。
});

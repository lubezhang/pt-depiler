import { bootstrapApp, disposeActiveApp } from "./bootstrap.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";

const acceptance = import.meta.env.DEV && import.meta.env.VITE_STAGE_A_GUI === "1";
const peer = acceptance && new URLSearchParams(location.search).has("stage-a-peer");
const app = peer
  ? import("~/acceptance/stage-a-gui.ts").then(async ({ runStageAPeer }) => {
      await runStageAPeer();
    })
  : bootstrapApp();
if (acceptance && !peer) {
  void app.then(async () => {
    const { runStageAMain } = await import("~/acceptance/stage-a-gui.ts");
    await runStageAMain();
  });
}
void app.catch(() => {
  // bootstrapApp 已渲染诊断页并写入结构化日志。
});

void getCurrentWindow()
  .onCloseRequested(async (event) => {
    event.preventDefault();
    try {
      await disposeActiveApp();
      await getCurrentWindow().destroy();
    } catch {
      console.error("[bootstrap] Failed to dispose application");
    }
  })
  .catch(() => console.error("[bootstrap] Failed to register window close handler"));

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disposeActiveApp().catch(() => console.error("[bootstrap] Failed to dispose application during HMR"));
  });
}

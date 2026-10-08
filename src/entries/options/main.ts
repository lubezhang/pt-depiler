import { bootstrapApp, disposeActiveApp } from "./bootstrap.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";

const acceptance = import.meta.env.DEV && import.meta.env.VITE_STAGE_A_GUI === "1";
const migrationAcceptance = acceptance && Boolean(import.meta.env.VITE_STAGE_B_MIGRATION_GUI);
const peer = acceptance && new URLSearchParams(location.search).has("stage-a-peer");
const app = migrationAcceptance
  ? import("~/acceptance/stage-b-migration-gui.ts").then(async ({ runStageBMigrationMain, runStageBMigrationPeer }) => {
      if (peer) await runStageBMigrationPeer();
      else await runStageBMigrationMain();
    })
  : peer
    ? import("~/acceptance/stage-a-gui.ts").then(async ({ runStageAPeer }) => {
        await runStageAPeer();
      })
    : bootstrapApp();
if (acceptance && !peer && !migrationAcceptance) {
  void app.then(async () => {
    if (import.meta.env.VITE_STAGE_C_GUI === "1") {
      const { runStageCMain } = await import("~/acceptance/stage-c-gui.ts");
      await runStageCMain();
      return;
    }
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

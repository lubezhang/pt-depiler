import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ptdIndexDb } from "@/offscreen/adapter/indexdb.ts";
import { migrateDownloadHistory } from "@/offscreen/adapter/downloadHistory.ts";
import { bootstrapApp, disposeActiveApp } from "@/options/bootstrap.ts";
import { invokeIpc } from "~/extends/tauri/ipc.ts";

const mode = import.meta.env.VITE_STAGE_B_MIGRATION_GUI;

export async function runStageBMigrationPeer(): Promise<void> {
  const database = await ptdIndexDb;
  await listen("stage-b:start", async () => {
    let passed = true;
    try {
      await migrateDownloadHistory();
    } catch {
      passed = false;
    }
    await emitTo("main", "stage-b:peer-response", { passed });
  });
  await listen("stage-b:finish", async () => await getCurrentWindow().close());
  await emitTo("main", "stage-b:peer-ready", { legacyCount: (await database.getAll("download_history")).length });
}

async function waitForPeer<T>(event: string, start: () => Promise<void>): Promise<T> {
  return await new Promise<T>(async (resolve, reject) => {
    const stop = await listen<T>(event, ({ payload }) => {
      window.clearTimeout(timeout);
      stop();
      resolve(payload);
    });
    const timeout = window.setTimeout(() => {
      stop();
      reject(new Error(`${event} timed out`));
    }, 15_000);
    await start().catch(reject);
  });
}

export async function runStageBMigrationMain(): Promise<void> {
  const results: string[] = [];
  let passed = false;
  try {
    if (mode === "inspect") {
      const database = await ptdIndexDb;
      results.push(`legacy-count:${(await database.getAll("download_history")).length}`);
      passed = true;
      return;
    }
    if (mode === "cleanup-fixture") {
      const database = await ptdIndexDb;
      const fixture = await database.get("download_history", 901);
      if (fixture?.siteId !== "isolated-fixture") throw new Error("fixture mismatch");
      await database.delete("download_history", 901);
      results.push("fixture-removed-by-id");
      passed = true;
      return;
    }
    const database = await ptdIndexDb;
    if (mode === "concurrent") {
      const localCount = (await database.getAll("download_history")).length;
      const peer = await waitForPeer<{ legacyCount: number }>("stage-b:peer-ready", async () => {
        await emit("stage-a:create-peer");
      });
      results.push(`source-counts:${localCount},${peer.legacyCount}`);
      if (localCount !== 1 || peer.legacyCount !== 0) throw new Error("unexpected webview sources");
      const peerResult = waitForPeer<{ passed: boolean }>("stage-b:peer-response", async () => {
        await emitTo("stage-a-peer", "stage-b:start", {});
      });
      await migrateDownloadHistory();
      if (!(await peerResult).passed) throw new Error("peer migration failed");
      await migrateDownloadHistory();
      const status = (await invokeIpc("get_storage_status", {})) as { imports?: Record<string, unknown> };
      const histories = (await invokeIpc("list_download_history", {})) as { id: number }[];
      results.push(`target-count:${histories.length}`);
      if (!status.imports?.downloadHistory || histories.length !== 1 || histories[0].id !== 901) {
        throw new Error("migrated history differs from legacy source");
      }
      results.push("two-webviews-import-once");
      if ((await database.getAll("download_history")).length !== 0) throw new Error("legacy source was not cleaned");
      results.push("committed-source-cleaned");
      await emitTo("stage-a-peer", "stage-b:finish", {});
      passed = true;
      return;
    }
    let startupFailed = false;
    try {
      await bootstrapApp();
    } catch {
      startupFailed = true;
    }
    if (mode === "seed") {
      if (startupFailed) throw new Error("seed startup failed");
      await database.put("download_history", {
        id: 901,
        siteId: "isolated-fixture",
        title: "migration-fixture",
        downloadStatus: "pending",
      } as never);
      results.push("legacy-indexeddb-seeded");
    } else if (mode === "retry-fail") {
      const status = (await invokeIpc("get_storage_status", {})) as { imports?: Record<string, unknown> };
      const legacyCount = (await database.getAll("download_history")).length;
      results.push(`startup-failed:${startupFailed}`);
      results.push(`migration-marker:${Boolean(status.imports?.downloadHistory)}`);
      results.push(`legacy-count:${legacyCount}`);
      if (!startupFailed || status.imports?.downloadHistory || legacyCount !== 1) {
        throw new Error("failed import changed its source or marker");
      }
      results.push("failed-import-keeps-indexeddb-source");
    } else {
      throw new Error("unknown migration acceptance mode");
    }
    passed = true;
  } catch (error) {
    results.push(`error:${error instanceof Error ? error.message : "unknown"}`);
    results.push("acceptance-failed");
  } finally {
    await disposeActiveApp().catch(() => undefined);
    await emit("stage-a:result", { platform: "macOS", mode, passed, results });
    await getCurrentWindow().close();
  }
}

import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invokeIpc } from "~/extends/tauri/ipc.ts";
import { createBackupData, restoreBackupData } from "@/offscreen/utils/backup.ts";
import { backupDataToJSZipBlob, jsZipBlobToBackupData } from "@ptd/backupServer/utils.ts";
import type { BackupSnapshot } from "~/application/backup/service.ts";

// Explicit debug-only entry; PTD_STAGE_A_GUI and PTD_E2E_DATA_DIR also isolate Rust and WKWebView storage.
export async function runStageCMain(): Promise<void> {
  const results: string[] = [];
  let passed = false;
  const require = (condition: boolean, name: string) => {
    if (!condition) throw new Error(name);
    results.push(name);
  };
  try {
    require(Boolean(document.querySelector("#app")?.children.length), "initial-mount-after-recovery");
    const snapshot = (await invokeIpc("get_backup_snapshot", { includeCookies: false })) as BackupSnapshot;
    const config = structuredClone(snapshot.data.config);
    config.backup.encryptionKey = "isolated-backup-key";
    const metadata = structuredClone(snapshot.data.metadata);
    metadata.sites.nyaa = { id: "nyaa", url: "https://nyaa.si/", inputSetting: { token: "ISOLATED_TOKEN" } };
    metadata.siteHostMap["nyaa.si"] = "nyaa";
    await invokeIpc("restore_backup_snapshot", {
      expectedRevision: snapshot.revision,
      data: { config, metadata },
      cookies: null,
    });
    await invokeIpc("set_cookie", {
      cookie: {
        name: "session",
        value: "ISOLATED_COOKIE",
        domain: "nyaa.si",
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: true,
        sameSite: "lax",
        expirationDate: null,
      },
    });
    const ordinary = await createBackupData(["config", "metadata", "downloadHistory"]);
    require(!JSON.stringify(ordinary).match(
      /ISOLATED_TOKEN|ISOLATED_COOKIE|isolated-backup-key/,
    ), "default-export-excludes-credentials-cookies-key");
    const sensitive = await createBackupData(["config", "metadata", "downloadHistory", "cookies"], {
      includeCredentials: true,
    });
    const archive = await backupDataToJSZipBlob(sensitive, "isolated-backup-key");
    let rejected = false;
    try {
      await jsZipBlobToBackupData(archive, "wrong-key");
    } catch {
      rejected = true;
    }
    require(rejected, "wrong-key-rejected-before-active-write");
    const decoded = await jsZipBlobToBackupData(archive, "isolated-backup-key");
    await invokeIpc("set_cookie", {
      cookie: {
        name: "session",
        value: "CHANGED_COOKIE",
        domain: "nyaa.si",
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: true,
        sameSite: "lax",
        expirationDate: null,
      },
    });
    await restoreBackupData(decoded, { fields: ["config", "metadata", "downloadHistory"] });
    const unchanged = await invokeIpc("get_cookies", { domain: "nyaa.si" });
    require(unchanged.some((cookie) => cookie.value === "CHANGED_COOKIE"), "default-restore-preserves-cookies");
    await restoreBackupData(decoded, {
      fields: ["config", "metadata", "downloadHistory", "cookies"],
      includeCredentials: true,
    });
    const final = (await invokeIpc("get_backup_snapshot", { includeCookies: true })) as BackupSnapshot;
    require((final.data.cookies as Array<{ value: string }>).some(
      (cookie) => cookie.value === "ISOLATED_COOKIE",
    ), "explicit-restore-converges-cookie-and-json");
    require(final.data.config.backup.encryptionKey === "isolated-backup-key", "restore-keeps-local-backup-key");
    const status = await invokeIpc("get_storage_status", {});
    require((status as { restore: { stage: string } }).restore.stage === "completed", "restore-completed-marker");
    require(!JSON.stringify(status).match(
      /ISOLATED_COOKIE|ISOLATED_TOKEN|isolated-backup-key/,
    ), "recovery-diagnostics-exclude-sensitive-payload");
    passed = true;
  } catch {
    results.push("unexpected-failure");
  } finally {
    await emit("stage-a:result", { platform: "macOS", stage: "C", passed, results });
    await getCurrentWindow().close();
  }
}

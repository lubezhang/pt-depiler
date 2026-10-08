import { invokeIpc } from "~/extends/tauri/ipc.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Repository } from "~/domain/ports/index.ts";
import type { ITorrentDownloadMetadata, TTorrentDownloadKey } from "@/shared/types.ts";
import { publicDownloadHistory } from "@/shared/security/artifacts.ts";
import { ptdIndexDb } from "./indexdb.ts";

type History = ITorrentDownloadMetadata;

export const downloadHistoryRepository: Repository<TTorrentDownloadKey, History> = {
  async clear() {
    return await invokeIpc("clear_download_history", {});
  },
  async delete(id) {
    return await invokeIpc("delete_download_history", { id });
  },
  async findAll() {
    return (await invokeIpc("list_download_history", {})) as History[];
  },
  async findById(id) {
    return ((await invokeIpc("get_download_history", { id })) as History | null) ?? undefined;
  },
  async insert(history) {
    return await invokeIpc("insert_download_history", { history: publicDownloadHistory(history) });
  },
  async save() {
    throw new Error("Conditional download history save is required");
  },
  async saveIfUnchanged(base, history) {
    const id = history.id;
    if (!id) throw new Error("Download history ID is required");
    const saved = await invokeIpc("save_download_history_if_unchanged", {
      id,
      base,
      history: publicDownloadHistory(history),
    });
    if (!saved) throw new Error("Download history was removed");
  },
};

export async function importLegacyRestoreJournals(): Promise<void> {
  if (getCurrentWindow().label !== "main") {
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = (await invokeIpc("get_storage_status", {})) as { imports?: Record<string, unknown> };
      if (status.imports?.legacyRestoreJournal) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Primary window did not complete legacy restore recovery");
  }
  const database = await ptdIndexDb;
  // Older releases may contain this store; never create a new active journal there.
  if (!database.objectStoreNames.contains("restore_journal" as never)) {
    await invokeIpc("import_legacy_restore_journals", { journals: [], histories: [] });
    return;
  }
  const legacy = database as unknown as import("idb").IDBPDatabase;
  const journals = await legacy.getAll("restore_journal");
  const histories = (await database.getAll("download_history")).map(publicDownloadHistory);
  await invokeIpc("import_legacy_restore_journals", { journals, histories });
  await legacy
    .clear("restore_journal")
    .catch(() => console.warn("[restore] Legacy journal cleanup will retry at next startup"));
}

export async function migrateDownloadHistory(): Promise<void> {
  if (getCurrentWindow().label !== "main") {
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = (await invokeIpc("get_storage_status", {})) as { imports?: Record<string, unknown> };
      if (status.imports?.downloadHistory) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Primary window did not complete download history migration");
  }
  const migrate = async () => {
    const status = (await invokeIpc("get_storage_status", {})) as { imports?: Record<string, unknown> };
    const database = await ptdIndexDb;
    if (!status.imports?.downloadHistory) {
      const histories = (await database.getAll("download_history")).map(publicDownloadHistory);
      await invokeIpc("import_download_history", { histories });
      return;
    }
    await database.clear("download_history");
  };
  if (navigator.locks) {
    await navigator.locks.request("ptd-download-history-migration", { mode: "exclusive" }, migrate);
  } else {
    await migrate();
  }
}

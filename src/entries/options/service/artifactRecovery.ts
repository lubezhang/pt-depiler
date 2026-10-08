import { extStorage } from "@/storage.ts";
import { ptdIndexDb } from "@/offscreen/adapter/indexdb.ts";
import {
  publicDownloadHistory,
  publicKeepUploadTask,
  publicSearchSnapshot,
  publicDownloadOptions,
} from "@/shared/security/artifacts.ts";
import { cachedUserInfo, publicUserHistory } from "@/offscreen/utils/backupRedaction.ts";
import { publicSocialInformation } from "@/shared/security/social.ts";

export async function repairPersistentArtifacts(): Promise<void> {
  sessionStorage.removeItem("__ptd_runtime_store");
  const database = await ptdIndexDb;
  const transaction = database.transaction("download_history", "readwrite");
  for (const history of await transaction.store.getAll()) {
    const safe = publicDownloadHistory(history);
    if (JSON.stringify(safe) !== JSON.stringify(history)) await transaction.store.put(safe);
  }
  await transaction.done;
  const social = database.transaction("social_information", "readwrite");
  let cursor = await social.store.openCursor();
  while (cursor) {
    await cursor.update(publicSocialInformation(cursor.value));
    cursor = await cursor.continue();
  }
  await social.done;
  const tasks = await extStorage.getItem("keepUploadTask");
  const snapshots = await extStorage.getItem("searchResultSnapshot");
  const history = await extStorage.getItem("userInfo");
  const metadata = await extStorage.getItem("metadata");
  const base = {
    keepUploadTask: tasks,
    searchResultSnapshot: snapshots,
    userInfo: history,
    ...(metadata && { metadata }),
  };
  const value = {
    keepUploadTask: Object.fromEntries(
      Object.entries(tasks ?? {}).map(([id, task]) => [id, publicKeepUploadTask(task)]),
    ),
    searchResultSnapshot: Object.fromEntries(
      Object.entries(snapshots ?? {}).map(([id, snapshot]) => [id, publicSearchSnapshot(snapshot)]),
    ),
    userInfo: publicUserHistory(history, cachedUserInfo),
    ...(metadata && {
      metadata: {
        ...metadata,
        lastDownloader: metadata.lastDownloader
          ? { id: metadata.lastDownloader.id, options: publicDownloadOptions(metadata.lastDownloader.options ?? {}) }
          : {},
        lastUserInfo: Object.fromEntries(
          Object.entries(metadata.lastUserInfo ?? {}).map(([id, info]) => [id, cachedUserInfo(info)]),
        ),
      },
    }),
  };
  if (JSON.stringify(base) !== JSON.stringify(value)) await extStorage.mergeBatch(base, value as never);
}

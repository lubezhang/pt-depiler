// @vitest-environment node
import { expect, it, vi } from "vitest";
import { BackupService } from "~/application/backup/service.ts";
import { backupDataToJSZipBlob, jsZipBlobToBackupData } from "@ptd/backupServer/utils.ts";

it("AP-13 v2 archive roundtrip preserves domains; wrong key fails before restore commit", async () => {
  const commit = vi.fn(async () => "restore-1");
  const service = new BackupService({
    snapshot: async () => ({
      revision: 9,
      data: { config: { theme: "dark", backup: { encryptionKey: "fixture-key" } }, downloadHistory: [] },
    }),
    commit,
    sanitize: (_field, value) => value,
    now: () => 1000,
    version: "fixture",
  });
  const { data, encryptionKey } = await service.prepareExport(["config", "downloadHistory"]);
  const archive = await backupDataToJSZipBlob(data, encryptionKey);
  await expect(jsZipBlobToBackupData(archive, "wrong-key")).rejects.toThrow();
  expect(commit).not.toHaveBeenCalled();
  const restored = await jsZipBlobToBackupData(archive, encryptionKey);
  expect(restored.manifest).toMatchObject({ formatVersion: 2, dataFormatVersion: 1 });
  expect(JSON.stringify(restored)).not.toContain("fixture-key");
  await service.restore(restored, { fields: ["config", "downloadHistory"] });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledWith(9, expect.objectContaining({ downloadHistory: [] }), undefined);
});

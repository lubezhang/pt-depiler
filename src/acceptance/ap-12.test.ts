// @vitest-environment node
import { expect, it, vi } from "vitest";
import { BackupService } from "~/application/backup/service.ts";

it("AP-12 default export and restore neither read nor commit Cookies", async () => {
  const snapshot = vi.fn(async () => ({ revision: 1, data: { config: {} } }));
  const commit = vi.fn(async () => "restore-1");
  const service = new BackupService({
    snapshot,
    commit,
    sanitize: (_field, value) => value,
    now: () => 1,
    version: "fixture",
  });
  const { data } = await service.prepareExport(["config"]);
  expect(data).not.toHaveProperty("cookies");
  await service.restore(
    {
      manifest: { files: { config: {}, cookies: {} } },
      config: {},
      cookies: { all: [{ value: "COOKIE_SENTINEL" }] },
    } as never,
    { fields: ["config"] },
  );
  expect(snapshot.mock.calls.every(([includeCookies]: unknown[]) => includeCookies === false)).toBe(true);
  expect(commit).toHaveBeenCalledWith(1, expect.any(Object), undefined);
  expect(JSON.stringify(commit.mock.calls)).not.toContain("COOKIE_SENTINEL");
});

it("AP-12 malformed explicit Cookie domain fails before any active commit", async () => {
  const commit = vi.fn(async () => "restore-1");
  const service = new BackupService({
    snapshot: async () => ({ revision: 1, data: {} }),
    commit,
    sanitize: (_field, value) => value,
    now: () => 1,
    version: "fixture",
  });
  await expect(
    service.restore(
      { manifest: { files: { config: {}, cookies: {} } }, config: {}, cookies: { all: "invalid" } } as never,
      { fields: ["config", "cookies"] },
    ),
  ).rejects.toThrow("BACKUP_INVALID_COOKIES");
  expect(commit).not.toHaveBeenCalled();
});

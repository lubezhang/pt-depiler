// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { BackupService, type BackupSnapshot } from "./service.ts";

function fixture() {
  const snapshot = vi.fn(async (): Promise<BackupSnapshot> => ({
    revision: 7,
    data: {
      config: { theme: "light", backup: { encryptionKey: "local-key" } },
      metadata: {
        sites: { tracker: { id: "tracker", inputSetting: { token: "site-secret" } } },
        downloaders: {
          client: {
            id: "client",
            type: "Transmission",
            password: "downloader-secret",
            address: "https://client.example",
          },
        },
      },
      downloadHistory: [],
      userInfo: {},
      cookies: [{ name: "session", value: "cookie-secret" }],
    },
  }));
  const commit = vi.fn(async () => "restore-1");
  const service = new BackupService({
    snapshot,
    commit,
    sanitize: (_field, value) => value,
    now: () => 1000,
    version: "fixture",
  });
  return { service, snapshot, commit };
}

describe("AP-13 backup snapshot and explicit secret selection", () => {
  it("redacts defaults even with an encryption key, and excludes the key with credentials enabled", async () => {
    const { service, snapshot } = fixture();
    const ordinary = await service.prepareExport(["config", "metadata"]);
    expect(JSON.stringify(ordinary.data)).not.toMatch(/local-key|site-secret|downloader-secret|cookie-secret/);
    expect(ordinary.encryptionKey).toBe("local-key");
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith(false);
    const sensitive = await service.prepareExport(["config", "metadata", "cookies"], { includeCredentials: true });
    expect(JSON.stringify(sensitive.data)).toContain("site-secret");
    expect(JSON.stringify(sensitive.data)).toContain("downloader-secret");
    expect(JSON.stringify(sensitive.data)).toContain("cookie-secret");
    expect(JSON.stringify(sensitive.data)).not.toContain("local-key");
  });

  it("uses one snapshot for configuration, credentials, encryption and history", async () => {
    const { service, snapshot } = fixture();
    await service.prepareExport(["config", "metadata", "downloadHistory"], { includeCredentials: true });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("commits every selected domain once, keeps existing secrets and never mutates backup Cookies", async () => {
    const { service, commit } = fixture();
    const input = {
      manifest: { redactedSecrets: true, files: { config: {}, metadata: {}, downloadHistory: {}, cookies: {} } },
      config: { theme: "dark" },
      metadata: { downloaders: { client: { id: "client", type: "Transmission", enabled: true } } },
      downloadHistory: [],
      cookies: { tracker: [{ name: "session", value: "cookie-secret", expirationDate: 1 }] },
    };
    const before = structuredClone(input);
    await service.restore(input as never, {
      fields: ["config", "metadata", "downloadHistory", "cookies"],
      expandCookieMinutes: 10,
    });
    expect(commit).toHaveBeenCalledTimes(1);
    const [revision, data, cookies] = commit.mock.calls[0] as unknown as [number, any, any[]];
    expect(revision).toBe(7);
    expect(data.config.backup.encryptionKey).toBe("local-key");
    expect(data.metadata.downloaders.client.password).toBe("downloader-secret");
    expect(data.downloadHistory).toEqual([]);
    expect(cookies[0].expirationDate).toBe(601);
    expect(input).toEqual(before);
  });

  it("validates all fields before commit and propagates conflicts without retrying", async () => {
    const { service, commit } = fixture();
    await expect(
      service.restore({ manifest: { files: { downloadHistory: {} } }, downloadHistory: {} } as never, {
        fields: ["downloadHistory"],
      }),
    ).rejects.toThrow("BACKUP_INVALID_DOMAIN");
    expect(commit).not.toHaveBeenCalled();
    commit.mockRejectedValueOnce({ code: "STORAGE_CONFLICT" });
    await expect(
      service.restore({ manifest: { files: { config: {} } }, config: {} } as never, { fields: ["config"] }),
    ).rejects.toEqual({ code: "STORAGE_CONFLICT" });
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

it("AP-13 Cookie changes during export reject the archive", async () => {
  const { service, snapshot } = fixture();
  snapshot.mockResolvedValueOnce({
    revision: 7,
    data: { config: { backup: { encryptionKey: "key" } }, cookies: [{ name: "session", value: "before" }] },
  });
  snapshot.mockResolvedValueOnce({
    revision: 7,
    data: { config: { backup: { encryptionKey: "key" } }, cookies: [{ name: "session", value: "after" }] },
  });
  await expect(service.prepareExport(["cookies"])).rejects.toThrow("BACKUP_COOKIE_SNAPSHOT_CHANGED");
});

it("AP-13 restores credentials only when explicitly selected and keeps the local backup key", async () => {
  const { service, commit } = fixture();
  const input = {
    manifest: { files: { config: {}, metadata: {} }, redactedSecrets: false },
    config: { backup: { encryptionKey: "foreign-key" } },
    metadata: { downloaders: { client: { id: "client", type: "Transmission", password: "restored-secret" } } },
  };
  await service.restore(input as never, { fields: ["config", "metadata"] });
  expect((commit.mock.calls[0] as unknown as [number, any])[1].metadata.downloaders.client.password).toBe(
    "downloader-secret",
  );
  await service.restore(input as never, { fields: ["config", "metadata"], includeCredentials: true });
  const restored = (commit.mock.calls[1] as unknown as [number, any])[1];
  expect(restored.metadata.downloaders.client.password).toBe("restored-secret");
  expect(restored.config.backup.encryptionKey).toBe("local-key");
});

// @vitest-environment node
import { expect, it, vi } from "vitest";
import { RemoteBackupService } from "./remote.ts";

it("AP-15 remote backup reads current configuration and refuses removed resources", async () => {
  let config: any = { id: "remote", type: "OWSS", name: "backup", config: { address: "https://old.example" } };
  const client = {
    setEncryptionKey: vi.fn(),
    addFile: vi.fn(async () => true),
    list: vi.fn(async () => []),
    getFile: vi.fn(),
    deleteFile: vi.fn(),
  };
  const create = vi.fn(async (config) => {
    expect(config.config.address).toMatch(/^https:\/\//);
    return client;
  });
  const recordSuccess = vi.fn(async () => undefined);
  const service = new RemoteBackupService({ config: async () => config, create, recordSuccess });
  await service.export("remote", "backup.zip", { config: {} }, "key");
  expect(create.mock.calls[0][0].config.address).toBe("https://old.example");
  config = { ...config, config: { address: "https://new.example" } };
  await service.export("remote", "backup.zip", { config: {} }, "key");
  expect(create.mock.calls[1][0].config.address).toBe("https://new.example");
  config = undefined;
  await expect(service.list("remote")).rejects.toThrow("BACKUP_SERVER_UNAVAILABLE");
  expect(create).toHaveBeenCalledTimes(2);
  expect(recordSuccess).toHaveBeenCalledTimes(2);
});

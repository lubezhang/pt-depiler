import { beforeEach, expect, it, vi } from "vitest";
import { InMemoryLogger } from "~/domain/ports/index.ts";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getItem: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem } }));
vi.mock("@/messages.ts", () => ({ onMessage: vi.fn() }));
import { verifySyncedSiteLogin } from "@/options/service/siteLogin.ts";
import { DownloadSubmission } from "~/application/download-service/submission.ts";
import { RemoteBackupService } from "~/application/backup/remote.ts";
import { getSite } from "@ptd/site";
import { getDownloader } from "@ptd/downloader";
import { getBackupServer } from "@ptd/backupServer";
import { siteDependencies } from "@/offscreen/adapter/site.ts";
import { downloaderDependencies } from "@/offscreen/adapter/downloader.ts";
import { backupServerDependencies } from "@/offscreen/adapter/backupServer.ts";
import { invalidateHostMapCache } from "~/extends/axios/tauriAdapter.ts";

beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "fixture");
  invalidateHostMapCache();
  mocks.getItem.mockResolvedValue({ siteHostMap: { "nyaa.si": "nyaa" } });
  mocks.invoke.mockReset();
});

it("AP-15 production account validation rejects changed origins and removed sites", async () => {
  mocks.getItem.mockResolvedValue({ sites: { nyaa: { url: "https://changed.example/" } } });
  await expect(verifySyncedSiteLogin({ siteId: "nyaa", siteUrl: "https://nyaa.si/" }, 1)).rejects.toThrow(
    "SITE_CONFIGURATION_CHANGED",
  );
  mocks.getItem.mockResolvedValue({ sites: {} });
  await expect(verifySyncedSiteLogin({ siteId: "nyaa", siteUrl: "https://nyaa.si/" }, 1)).rejects.toThrow(
    "SITE_NOT_CONFIGURED",
  );
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("AP-15 download and backup use cases re-read changed resources and reject deletion", async () => {
  let downloaderConfig: any = { id: "client", enabled: true, address: "https://old.example" };
  const getClient = vi.fn(async () => ({ addTorrent: async () => ({ success: true }) }));
  const submission = new DownloadSubmission({ getConfig: async () => downloaderConfig, getClient });
  await submission.execute("client", "magnet:?xt=fixture", {});
  downloaderConfig = { ...downloaderConfig, address: "https://new.example" };
  await submission.execute("client", "magnet:?xt=fixture", {});
  downloaderConfig = undefined;
  await expect(submission.execute("client", "magnet:?xt=fixture", {})).rejects.toThrow("DOWNLOADER_UNAVAILABLE");
  expect(getClient).toHaveBeenCalledTimes(2);

  let config: any = { id: "remote", config: { address: "https://old.example" } };
  const create = vi.fn(async (_config: any) => ({ setEncryptionKey: vi.fn(), list: async () => [] }) as never);
  const remote = new RemoteBackupService({ config: async () => config, create, recordSuccess: vi.fn() });
  await remote.list("remote");
  config = { ...config, config: { address: "https://new.example" } };
  await remote.list("remote");
  expect(create.mock.calls[1][0].config.address).toBe("https://new.example");
  config = undefined;
  await expect(remote.list("remote")).rejects.toThrow();
  expect(create).toHaveBeenCalledTimes(2);
});

it("AP-15 factories bind downloader and backup requests to explicit resource identities", async () => {
  mocks.invoke.mockImplementation(async (_name, { req }) => ({
    status: 200,
    statusText: "OK",
    headers: {},
    body: req.siteId.startsWith("downloader:")
      ? JSON.stringify({ result: "success", arguments: {} })
      : JSON.stringify({ code: 0, data: [] }),
    binary: false,
    finalUrl: req.url,
  }));
  const downloader = await getDownloader(
    { id: "client", type: "Transmission", name: "fixture", address: "http://client.example" },
    downloaderDependencies("client"),
  );
  await expect(downloader.pauseTorrent(1)).resolves.toBe(true);
  const backup = await getBackupServer(
    { id: "server", type: "OWSS", name: "fixture", config: { address: "https://backup.example", authCode: "fixture" } },
    backupServerDependencies("server"),
  );
  await backup.ping();
  expect(mocks.invoke).toHaveBeenCalledWith(
    "ptd_fetch",
    expect.objectContaining({ req: expect.objectContaining({ siteId: "downloader:client" }) }),
  );
  expect(mocks.invoke).toHaveBeenCalledWith(
    "ptd_fetch",
    expect.objectContaining({ req: expect.objectContaining({ siteId: "backup:server" }) }),
  );
});

// @vitest-environment node
import { expect, it, vi } from "vitest";
import { DownloadSubmission } from "./submission.ts";

it("AP-15 submission rereads resources, preserves downloader results and blocks removed/disabled configurations", async () => {
  let config: any = { id: "client", enabled: true };
  const result = { success: true };
  const addTorrent = vi.fn(async () => result);
  const getClient = vi.fn(async () => ({ addTorrent }));
  const service = new DownloadSubmission({ getConfig: async () => config, getClient });
  await expect(service.execute("client", "magnet:?xt=fixture", { savePath: "/data" })).resolves.toBe(result);
  expect(addTorrent).toHaveBeenCalledWith("magnet:?xt=fixture", { savePath: "/data" });
  config.enabled = false;
  await expect(service.execute("client", "magnet:?xt=fixture", {})).rejects.toThrow("DOWNLOADER_UNAVAILABLE");
  config = undefined;
  await expect(service.execute("client", "magnet:?xt=fixture", {})).rejects.toThrow("DOWNLOADER_UNAVAILABLE");
  expect(getClient).toHaveBeenCalledTimes(1);
});

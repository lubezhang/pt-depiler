import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (message: { data: any }) => Promise<unknown>>();
  const history = new Map<number, Record<string, unknown>>();
  return {
    getDownloader: vi.fn(),
    getRemoteTorrentFile: vi.fn(),
    getSiteInstance: vi.fn(),
    handlers,
    history,
    logger: vi.fn(),
    onMessage: vi.fn((name: string, handler: (message: { data: any }) => Promise<unknown>) => {
      handlers.set(name, handler);
    }),
    put: vi.fn((_: string, value: Record<string, unknown>) => {
      history.set(value.id as number, value);
      return value.id;
    }),
    sendMessage: vi.fn(),
  };
});

vi.mock("@ptd/downloader", () => ({
  getDownloader: mocks.getDownloader,
  getRemoteTorrentFile: mocks.getRemoteTorrentFile,
}));
vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("./logger.ts", () => ({ logger: mocks.logger }));
vi.mock("./site.ts", () => ({ getSiteInstance: mocks.getSiteInstance }));
vi.mock("../adapter/indexdb.ts", () => ({
  ptdIndexDb: Promise.resolve({
    clear: vi.fn(),
    delete: vi.fn(),
    get: vi.fn((_: string, id: number) => mocks.history.get(id)),
    getAll: vi.fn(),
    put: mocks.put,
  }),
}));

import "./download.ts";

function downloadHandler() {
  return mocks.handlers.get("downloadTorrent")!;
}

function configureLocalDownload(method: "browser" | "extension") {
  mocks.sendMessage.mockImplementation((name: string) => {
    if (name === "getExtStorage") return Promise.resolve({ download: { localDownloadMethod: method } });
    if (name === "downloadFile") return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  mocks.getDownloader.mockReset();
  mocks.getRemoteTorrentFile.mockReset();
  mocks.getSiteInstance.mockReset();
  mocks.history.clear();
  mocks.logger.mockReset();
  mocks.put.mockReset();
  mocks.sendMessage.mockReset();
  mocks.put.mockImplementation((_: string, value: Record<string, unknown>) => {
    mocks.history.set(value.id as number, value);
    return value.id;
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(500));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("下载失败边界", () => {
  it("非零短延迟调度不会阻塞原下载调用", async () => {
    mocks.history.set(1, { id: 1, downloadStatus: "pending" });
    mocks.getSiteInstance.mockResolvedValue({
      downloadInterval: 1,
      getTorrentDownloadRequestConfig: vi.fn(),
      userConfig: {},
    });
    mocks.sendMessage.mockImplementation((name: string) => {
      if (name === "getExtStorage") return Promise.resolve({ download: {} });
      if (name === "reDownloadTorrent") return new Promise(() => {});
      return Promise.resolve(undefined);
    });

    let result: unknown;
    void downloadHandler()({
      data: { downloadId: 1, downloaderId: "local", torrent: { site: "siteA", link: "https://tracker.test/a" } },
    }).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(result).toMatchObject({ downloadId: 1, downloadStatus: "pending" });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "reDownloadTorrent",
      expect.objectContaining({ downloadId: 1, leftInterval: 500 }),
    );
  });

  it.each(["completed", "failed"] as const)("近零延迟重试的 %s 状态不会被 pending 覆盖", async (finalStatus) => {
    vi.setSystemTime(new Date(999));
    mocks.history.set(4, { id: 4, downloadStatus: "pending" });
    mocks.getSiteInstance.mockResolvedValue({
      downloadInterval: 1,
      getTorrentDownloadRequestConfig: vi.fn(),
      userConfig: {},
    });
    mocks.sendMessage.mockImplementation((name: string) => {
      if (name === "getExtStorage") return Promise.resolve({ download: {} });
      if (name === "reDownloadTorrent") {
        mocks.history.set(4, { id: 4, downloadStatus: finalStatus });
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    await expect(
      downloadHandler()({
        data: { downloadId: 4, downloaderId: "local", torrent: { site: "siteB", link: "https://tracker.test/b" } },
      }),
    ).resolves.toMatchObject({ downloadId: 4, downloadStatus: "pending" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.history.get(4)).toMatchObject({ downloadStatus: finalStatus });
  });

  it("browser 文件保存成功后状态写入失败不会回退并重复下载", async () => {
    const statusError = new Error("history unavailable");
    mocks.history.set(2, { id: 2, downloadStatus: "pending" });
    configureLocalDownload("browser");
    let putCount = 0;
    mocks.put.mockImplementation((_: string, value: Record<string, unknown>) => {
      putCount += 1;
      if (putCount === 4) throw statusError;
      mocks.history.set(value.id as number, value);
      return value.id;
    });

    await expect(
      downloadHandler()({
        data: { downloadId: 2, downloaderId: "local", torrent: { link: "https://tracker.test/a" } },
      }),
    ).rejects.toThrow('Failed to persist torrent download status "completed"');

    expect(mocks.sendMessage.mock.calls.filter(([name]) => name === "downloadFile")).toEqual([
      ["downloadFile", { url: "https://tracker.test/a" }],
    ]);
    expect(mocks.getRemoteTorrentFile).not.toHaveBeenCalled();
  });

  it("extension 文件保存成功后状态写入失败会传播且不重复副作用", async () => {
    const statusError = new Error("history unavailable");
    mocks.history.set(3, { id: 3, downloadStatus: "pending" });
    configureLocalDownload("extension");
    mocks.getRemoteTorrentFile.mockResolvedValue({
      metadata: { blob: () => new Blob(["torrent"]) },
      name: "fixture.torrent",
    });
    const createObjectUrl = vi.fn(() => "blob:fixture");
    const revokeObjectUrl = vi.fn();
    URL.createObjectURL = createObjectUrl;
    URL.revokeObjectURL = revokeObjectUrl;
    let putCount = 0;
    mocks.put.mockImplementation((_: string, value: Record<string, unknown>) => {
      putCount += 1;
      if (putCount === 4) throw statusError;
      mocks.history.set(value.id as number, value);
      return value.id;
    });

    await expect(
      downloadHandler()({
        data: { downloadId: 3, downloaderId: "local", torrent: { link: "https://tracker.test/a" } },
      }),
    ).rejects.toThrow('Failed to persist torrent download status "completed"');

    expect(mocks.sendMessage).toHaveBeenCalledWith("downloadFile", {
      url: "blob:fixture",
      filename: "fixture.torrent",
    });
    expect(mocks.sendMessage.mock.calls.filter(([name]) => name === "downloadFile")).toHaveLength(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:fixture");
  });

  it("远端下载诊断写入先完成，最终状态保留 completed 与下载器响应", async () => {
    const addTorrentResult = { success: true, id: "remote-task" };
    mocks.history.set(5, { id: 5, downloadStatus: "pending" });
    mocks.getDownloader.mockResolvedValue({ addTorrent: vi.fn().mockResolvedValue(addTorrentResult) });
    mocks.sendMessage.mockImplementation((name: string, key?: string) => {
      if (name !== "getExtStorage") return Promise.resolve(undefined);
      if (key === "metadata") {
        return Promise.resolve({ downloaders: { remote: { id: "remote", enabled: true } } });
      }
      return Promise.resolve({ download: {} });
    });
    let releaseDiagnosticWrite!: () => void;
    const diagnosticWrite = new Promise<void>((resolve) => {
      releaseDiagnosticWrite = resolve;
    });
    const writes: Record<string, unknown>[] = [];
    mocks.put.mockImplementation((_: string, value: Record<string, unknown>) => {
      if ("addTorrentResult" in value) {
        return diagnosticWrite.then(() => {
          mocks.history.set(value.id as number, value);
          writes.push(value);
          return value.id;
        });
      }
      mocks.history.set(value.id as number, value);
      writes.push(value);
      return value.id;
    });

    let settled = false;
    const request = downloadHandler()({
      data: {
        downloadId: 5,
        downloaderId: "remote",
        torrent: { link: "https://tracker.test/a" },
        addTorrentOptions: {},
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(false);
    expect(writes.some((value) => value.downloadStatus === "completed")).toBe(false);
    releaseDiagnosticWrite();

    await expect(request).resolves.toMatchObject({ downloadStatus: "completed" });
    expect(mocks.history.get(5)).toMatchObject({ downloadStatus: "completed", addTorrentResult });
  });
});

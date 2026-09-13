import { beforeAll, describe, expect, it, vi } from "vitest";

const { downloadHistory, indexDb } = vi.hoisted(() => {
  const downloadHistory = new Map<number, Record<string, unknown>>();
  return {
    downloadHistory,
    indexDb: {
      clear: vi.fn(),
      delete: vi.fn(),
      get: vi.fn((_store: string, id: number) => downloadHistory.get(id)),
      getAll: vi.fn(),
      put: vi.fn((_store: string, value: Record<string, unknown>) => {
        downloadHistory.set(value.id as number, value);
        return value.id;
      }),
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/storage.ts", () => ({
  extStorage: {
    getItem: vi.fn().mockResolvedValue({}),
    setItem: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({
  ptdIndexDb: Promise.resolve(indexDb),
}));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

import { assertAllProtocolHandlersRegistered, onMessage, protocolNames, sendMessage } from "./messages.ts";

describe("公开协议完整性", () => {
  it("缺失公开协议时完整性断言列出缺失协议", () => {
    expect(assertAllProtocolHandlersRegistered).toThrow("Missing handlers for protocols: downloadFile");
  });
});

describe("消息协议", () => {
  beforeAll(async () => {
    await import("./options/service/index.ts");
  });

  it("应用启动后为每个公开协议注册 handler", () => {
    expect(protocolNames).toContain("setDownloadHistoryStatus");
    expect(assertAllProtocolHandlersRegistered).not.toThrow();
  });

  it("未知协议时错误包含协议名", async () => {
    await expect(sendMessage("missingHandler" as never, undefined as never)).rejects.toThrow(
      'No handler registered for message "missingHandler"',
    );
  });

  it("下载重试 handler 失败后将历史记录更新为 failed", async () => {
    downloadHistory.set(2, { id: 2, downloadStatus: "pending" });
    onMessage("downloadTorrent", async () => {
      throw new Error("retry failed");
    });

    await expect(
      sendMessage("reDownloadTorrent", {
        downloadId: 2,
        downloaderId: "local",
        leftInterval: 0,
        torrent: {},
      }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => expect(downloadHistory.get(2)).toMatchObject({ downloadStatus: "failed" }));
  });

  it("下载状态持久化失败时向调用方传播错误", async () => {
    downloadHistory.set(3, { id: 3, downloadStatus: "pending" });
    indexDb.put.mockRejectedValueOnce(new Error("history storage unavailable"));

    await expect(sendMessage("setDownloadHistoryStatus", { downloadId: 3, status: "failed" })).rejects.toThrow(
      'Failed to persist torrent download status "failed"',
    );
  });
});

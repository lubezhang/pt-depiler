import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const callbacks = new Map<string, (event: { payload?: unknown }) => void>();
  return {
    callbacks,
    getItem: vi.fn(),
    invoke: vi.fn(),
    listen: vi.fn((eventName: string, callback: (event: { payload?: unknown }) => void) => {
      callbacks.set(eventName, callback);
      return Promise.resolve(() => {});
    }),
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    setItem: vi.fn(),
    sleep: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem, setItem: mocks.setItem } }));
vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("~/helper.ts", () => ({ sleep: mocks.sleep }));

import {
  handleReDownload,
  handleScheduledRedownload,
  registerSchedulerListeners,
  runAutoBackup,
  runAutoFlushUserInfo,
} from "./alarms.ts";

const redownload = {
  downloadId: 42,
  downloaderId: "local" as const,
  leftInterval: 0,
  torrent: {},
};

function loggerMessages(level: "error" | "info") {
  return mocks.sendMessage.mock.calls
    .filter(([name, data]) => name === "logger" && (data as { level?: string }).level === level)
    .map(([, data]) => (data as { msg: string }).msg);
}

beforeEach(() => {
  mocks.getItem.mockReset();
  mocks.invoke.mockReset();
  mocks.onMessage.mockReset();
  mocks.sendMessage.mockReset();
  mocks.setItem.mockReset();
  mocks.sleep.mockReset();
  mocks.getItem.mockResolvedValue(null);
  mocks.invoke.mockResolvedValue(undefined);
  mocks.sendMessage.mockResolvedValue(undefined);
  mocks.setItem.mockResolvedValue(undefined);
  mocks.sleep.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("后台定时任务失败处理", () => {
  it("短延迟重试失败时将下载历史标记为 failed", async () => {
    const error = new Error("retry failed");
    mocks.sendMessage.mockImplementation((name: string) => {
      if (name === "downloadTorrent") return Promise.reject(error);
      return Promise.resolve(undefined);
    });

    await handleReDownload({ ...redownload, leftInterval: 29_999 });

    expect(mocks.sleep).toHaveBeenCalledWith(29_999);
    expect(mocks.sendMessage).toHaveBeenCalledWith("setDownloadHistoryStatus", {
      downloadId: 42,
      status: "failed",
    });
    expect(loggerMessages("error")).toContain("Delayed torrent retry failed");
  });

  it("重试状态回写再次失败时记录诊断而不产生未处理拒绝", async () => {
    mocks.sendMessage.mockImplementation((name: string) => {
      if (name === "downloadTorrent") return Promise.reject(new Error("retry failed"));
      if (name === "setDownloadHistoryStatus") return Promise.reject(new Error("history unavailable"));
      return Promise.resolve(undefined);
    });

    await expect(handleReDownload({ ...redownload, leftInterval: 0 })).resolves.toBeUndefined();

    expect(loggerMessages("error")).toContain("Delayed torrent retry failed; failed to persist retry status");
  });

  it("Rust 调度请求失败时清理待重试项并标记历史失败", async () => {
    const error = new Error("scheduler unavailable");
    mocks.invoke.mockRejectedValue(error);

    await expect(handleReDownload({ ...redownload, leftInterval: 30_000 })).rejects.toBe(error);
    await handleScheduledRedownload(42);

    expect(mocks.invoke).toHaveBeenCalledWith("schedule_redownload", { downloadId: "42", delaySecs: 30 });
    expect(mocks.sendMessage).toHaveBeenCalledWith("setDownloadHistoryStatus", {
      downloadId: 42,
      status: "failed",
    });
    expect(mocks.sendMessage).not.toHaveBeenCalledWith("downloadTorrent", expect.anything());
  });

  it("Rust 重试事件执行失败时将下载历史标记为 failed", async () => {
    await handleReDownload({ ...redownload, leftInterval: 30_000 });
    mocks.sendMessage.mockImplementation((name: string) => {
      if (name === "downloadTorrent") return Promise.reject(new Error("retry failed"));
      return Promise.resolve(undefined);
    });

    mocks.callbacks.get("scheduler://redownload")!({ payload: "42" });
    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith("setDownloadHistoryStatus", {
        downloadId: 42,
        status: "failed",
      }),
    );
    mocks.callbacks.get("scheduler://redownload")!({ payload: "42" });
    await vi.runAllTicks();

    expect(mocks.sendMessage.mock.calls.filter(([name]) => name === "downloadTorrent")).toHaveLength(1);
  });

  it("自动备份返回失败结果时记录诊断", async () => {
    const metadata = {
      backupServers: {
        "server-1": { enabled: true, backupInterval: 1, lastBackupAt: 0, backupFields: ["metadata"] },
      },
    };
    mocks.getItem.mockResolvedValue(metadata);
    mocks.sendMessage.mockImplementation((name: string) => {
      if (name === "exportBackupData") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });

    await expect(runAutoBackup()).resolves.toBeUndefined();

    expect(mocks.sendMessage).toHaveBeenCalledWith("exportBackupData", {
      backupServerId: "server-1",
      backupFields: ["metadata"],
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "logger",
      expect.objectContaining({
        data: { backupServerId: "server-1" },
        msg: "Auto-backup returned an unsuccessful result",
      }),
    );
    expect(loggerMessages("error")).toContain("Auto-backup returned an unsuccessful result");
  });

  it("自动备份请求拒绝时记录诊断", async () => {
    mocks.getItem.mockResolvedValue({
      backupServers: { "server-1": { enabled: true, backupInterval: 1, lastBackupAt: 0 } },
    });
    mocks.sendMessage.mockImplementation((name: string) => {
      if (name === "exportBackupData") return Promise.reject(new Error("network failed"));
      return Promise.resolve(undefined);
    });

    await expect(runAutoBackup()).resolves.toBeUndefined();

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "logger",
      expect.objectContaining({ data: { backupServerId: "server-1" }, msg: "Auto-backup failed" }),
    );
    expect(loggerMessages("error")).toContain("Auto-backup failed");
  });

  it("后台诊断 logger 再次失败时回退到控制台", async () => {
    const loggerError = new Error("logger unavailable");
    mocks.getItem.mockResolvedValue({
      backupServers: { "server-1": { enabled: true, backupInterval: 1, lastBackupAt: 0 } },
    });
    mocks.sendMessage.mockImplementation((name: string) => {
      if (name === "exportBackupData") return Promise.resolve(false);
      if (name === "logger") return Promise.reject(loggerError);
      return Promise.resolve(undefined);
    });

    await runAutoBackup();
    await Promise.resolve();

    expect(console.error).toHaveBeenCalledWith(
      "[background] Failed to record task diagnostic: Auto-backup returned an unsuccessful result",
      loggerError,
    );
  });

  it("自动刷新单站失败后持久化刷新时间并记录诊断", async () => {
    const metadata = {
      lastUserInfoAutoFlushAt: 0,
      sites: { siteA: { isOffline: false, allowQueryUserInfo: true } },
    };
    mocks.getItem.mockImplementation((key: string) => {
      return Promise.resolve(
        key === "config"
          ? { userInfo: { autoReflush: { enabled: true, interval: 1, afterTime: "00:00", retry: { max: 0 } } } }
          : metadata,
      );
    });
    mocks.sendMessage.mockImplementation((name: string) => {
      if (name === "getSiteUserInfo") return Promise.reject(new Error("site unavailable"));
      return Promise.resolve(undefined);
    });

    await runAutoFlushUserInfo();

    expect(mocks.setItem).toHaveBeenCalledWith(
      "metadata",
      expect.objectContaining({ lastUserInfoAutoFlushAt: expect.any(Number) }),
    );
    expect(loggerMessages("error")).toContain("Auto-refresh failed for site siteA");
  });

  it("监听器注册失败时记录本地诊断", async () => {
    mocks.listen.mockRejectedValue(new Error("listener unavailable"));

    registerSchedulerListeners();
    await Promise.resolve();
    await Promise.resolve();

    expect(loggerMessages("error")).toEqual(
      expect.arrayContaining([
        "Failed to register auto-refresh scheduler listener",
        "Failed to register auto-backup scheduler listener",
        "Failed to register torrent retry scheduler listener",
      ]),
    );
  });
});

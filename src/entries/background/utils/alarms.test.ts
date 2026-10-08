import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  invoke: vi.fn(),
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem, setItem: mocks.setItem } }));
vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));

import {
  handleReDownload,
  handleScheduledRedownload,
  registerSchedulerListeners,
  runAutoBackup,
  runAutoFlushUserInfo,
} from "./alarms.ts";

const redownload = { downloadId: 42, downloaderId: "local" as const, leftInterval: 29_999, torrent: {} };

beforeEach(() => {
  mocks.getItem.mockReset();
  mocks.invoke.mockReset();
  mocks.sendMessage.mockReset();
  mocks.setItem.mockReset();
  mocks.getItem.mockResolvedValue(null);
  mocks.invoke.mockResolvedValue(null);
  mocks.sendMessage.mockResolvedValue(undefined);
  mocks.setItem.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("all redownload delays are durably scheduled", async () => {
  await handleReDownload(redownload);
  expect(mocks.invoke).toHaveBeenCalledWith("schedule_redownload", { downloadId: "42", delaySecs: 30 });
  expect(mocks.sendMessage).not.toHaveBeenCalledWith("downloadTorrent", expect.anything());
});

it("failed enqueue marks the existing download attempt as failed", async () => {
  const failure = new Error("repository unavailable");
  mocks.invoke.mockRejectedValue(failure);
  await expect(handleReDownload(redownload)).rejects.toBe(failure);
  expect(mocks.sendMessage).toHaveBeenCalledWith("setDownloadHistoryStatus", { downloadId: 42, status: "failed" });
});

it("completed history resolves an uncertain retry without another remote side effect", async () => {
  mocks.sendMessage.mockImplementation(async (name: string) =>
    name === "getDownloadHistoryById" ? { downloadStatus: "completed" } : undefined,
  );
  await expect(handleScheduledRedownload(42)).resolves.toBe("succeeded");
  expect(mocks.sendMessage).not.toHaveBeenCalledWith("downloadTorrent", expect.anything());
});

it("a missing history is left uncertain for manual review", async () => {
  await expect(handleScheduledRedownload(42)).rejects.toThrow("history is missing");
  expect(mocks.sendMessage).not.toHaveBeenCalledWith("downloadTorrent", expect.anything());
});

it("auto-backup reports failed service results to the task runner", async () => {
  mocks.getItem.mockResolvedValue({
    backupServers: { remote: { enabled: true, backupInterval: 1, lastBackupAt: 0, backupFields: ["metadata"] } },
  });
  mocks.sendMessage.mockImplementation(async (name: string) => {
    if (name === "confirmBackupCompletion") return false;
    return name === "exportBackupData" ? false : undefined;
  });
  await expect(runAutoBackup("remote", "PTD_backup_task_100.zip")).resolves.toBe(false);
  expect(mocks.sendMessage).toHaveBeenCalledWith("exportBackupData", {
    backupServerId: "remote",
    backupFields: ["metadata"],
    backupFilename: "PTD_backup_task_100.zip",
  });
});

it("remote backup already present converges without another upload", async () => {
  mocks.getItem.mockResolvedValue({
    backupServers: { remote: { enabled: true, backupInterval: 1, lastBackupAt: 0, backupFields: ["metadata"] } },
  });
  mocks.sendMessage.mockImplementation(async (name: string) => (name === "confirmBackupCompletion" ? true : undefined));
  await expect(runAutoBackup("remote", "PTD_backup_task_100.zip")).resolves.toBe(true);
  expect(mocks.sendMessage).not.toHaveBeenCalledWith("exportBackupData", expect.anything());
});

it("worker confirms a remote backup already present without uploading it again", async () => {
  let claimed = false;
  mocks.getItem.mockResolvedValue({
    backupServers: { remote: { enabled: true, backupInterval: 1, lastBackupAt: 0, backupFields: ["metadata"] } },
  });
  mocks.sendMessage.mockImplementation(async (name: string) => (name === "confirmBackupCompletion" ? true : undefined));
  mocks.invoke.mockImplementation(async (name: string) => {
    if (name === "claim_due_task" && !claimed) {
      claimed = true;
      return {
        id: "periodic:backup:remote",
        kind: "autoBackup",
        payload: { backupServerId: "remote", backupFilename: "PTD_backup_task_100.zip" },
      };
    }
    return null;
  });
  const stop = await registerSchedulerListeners();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "finish_task",
      expect.objectContaining({ taskId: "periodic:backup:remote", outcome: "succeeded" }),
    ),
  );
  await stop();
  expect(mocks.sendMessage).not.toHaveBeenCalledWith("exportBackupData", expect.anything());
});

it("disabled user info refresh completes without side effects", async () => {
  await expect(runAutoFlushUserInfo()).resolves.toBe(true);
  expect(mocks.setItem).not.toHaveBeenCalled();
});

it("worker polls the durable queue and acknowledges a claimed task", async () => {
  let claimed = false;
  mocks.sendMessage.mockImplementation(async (name: string) =>
    name === "getDownloadHistoryById" ? { downloadStatus: "completed" } : undefined,
  );
  mocks.invoke.mockImplementation(async (name: string) => {
    if (name === "claim_due_task" && !claimed) {
      claimed = true;
      return { id: "redownload:42", kind: "redownload", payload: { downloadId: 42 } };
    }
    return null;
  });
  const stop = await registerSchedulerListeners();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "finish_task",
      expect.objectContaining({
        taskId: "redownload:42",
        outcome: "succeeded",
      }),
    ),
  );
  await stop();
  expect(mocks.invoke).toHaveBeenCalledWith("release_tasks", expect.objectContaining({ owner: expect.any(String) }));
});

it("leaves an unconfirmed remote backup for manual review without automatic retry", async () => {
  let claimed = false;
  mocks.getItem.mockResolvedValue({
    backupServers: { remote: { enabled: true, backupInterval: 1, lastBackupAt: 0, backupFields: ["metadata"] } },
  });
  mocks.sendMessage.mockImplementation(async (name: string) => {
    if (name === "confirmBackupCompletion") return false;
    return name === "exportBackupData" ? false : undefined;
  });
  mocks.invoke.mockImplementation(async (name: string) => {
    if (name === "claim_due_task" && !claimed) {
      claimed = true;
      return {
        id: "periodic:backup:remote",
        kind: "autoBackup",
        payload: { backupServerId: "remote", backupFilename: "PTD_backup_task_100.zip" },
      };
    }
    return null;
  });
  const stop = await registerSchedulerListeners();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "finish_task",
      expect.objectContaining({ taskId: "periodic:backup:remote", outcome: "uncertain" }),
    ),
  );
  await stop();
});

it("worker startup fails when the persistent task store is unavailable", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("task store unavailable"));
  await expect(registerSchedulerListeners()).rejects.toThrow("task store unavailable");
});

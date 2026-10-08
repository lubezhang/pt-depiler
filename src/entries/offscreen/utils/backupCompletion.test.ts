import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metadata: { backupServers: { remote: { lastBackupAt: 0 } } },
  list: vi.fn(),
  getBackupServer: vi.fn(),
  getItem: vi.fn(),
  setItem: vi.fn(),
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
}));

vi.mock("@ptd/backupServer", () => ({ getBackupServer: mocks.getBackupServer }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem, setItem: mocks.setItem } }));
vi.mock("@/messages.ts", () => ({ sendMessage: mocks.sendMessage, onMessage: mocks.onMessage }));
vi.mock("./logger.ts", () => ({ logger: vi.fn() }));

import { confirmBackupCompletion } from "./backup.ts";

beforeEach(() => {
  vi.useFakeTimers();
  mocks.metadata.backupServers.remote.lastBackupAt = 0;
  mocks.list.mockReset();
  mocks.getBackupServer.mockReset();
  mocks.getItem.mockReset();
  mocks.setItem.mockReset();
  mocks.sendMessage.mockReset();
  mocks.getBackupServer.mockResolvedValue({ list: mocks.list });
  mocks.getItem.mockResolvedValue(mocks.metadata);
  mocks.sendMessage.mockResolvedValue({ backupServers: { remote: {} } });
  vi.setSystemTime(new Date(5000));
});

afterEach(() => vi.useRealTimers());

it("records confirmed remote backup completion with a conditional metadata update", async () => {
  mocks.list.mockResolvedValue([{ filename: "PTD_backup_task_100.zip" }]);
  await expect(confirmBackupCompletion("remote", "PTD_backup_task_100.zip")).resolves.toBe(true);
  expect(mocks.setItem).toHaveBeenCalledWith("metadata", mocks.metadata);
  expect(mocks.metadata.backupServers.remote.lastBackupAt).toBe(5000);
});

it("keeps the task unconfirmed when the remote file is absent or listing fails", async () => {
  mocks.list.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("remote unavailable"));
  await expect(confirmBackupCompletion("remote", "PTD_backup_task_100.zip")).resolves.toBe(false);
  await expect(confirmBackupCompletion("remote", "PTD_backup_task_100.zip")).rejects.toThrow("remote unavailable");
  expect(mocks.setItem).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows = [{ id: 1, downloadStatus: "pending", siteId: "site", title: "torrent" }];
  return {
    rows,
    imported: false,
    failImport: false,
    windowLabel: "main",
    getAll: vi.fn(async () => [...rows]),
    clear: vi.fn(async () => {
      rows.length = 0;
    }),
    invokeIpc: vi.fn(async (command: string) => {
      if (command === "get_storage_status") return { imports: mocks.imported ? { downloadHistory: {} } : {} };
      if (command === "import_download_history") {
        if (mocks.failImport) throw new Error("interrupted");
        mocks.imported = true;
      }
      return undefined;
    }),
  };
});

vi.mock("~/extends/tauri/ipc.ts", () => ({ invokeIpc: mocks.invokeIpc }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: mocks.windowLabel }) }));
vi.mock("./indexdb.ts", () => ({ ptdIndexDb: Promise.resolve({ getAll: mocks.getAll, clear: mocks.clear }) }));

import { migrateDownloadHistory } from "./downloadHistory.ts";

beforeEach(() => {
  mocks.rows.splice(0, mocks.rows.length, { id: 1, downloadStatus: "pending", siteId: "site", title: "torrent" });
  mocks.imported = false;
  mocks.failImport = false;
  mocks.windowLabel = "main";
  mocks.getAll.mockClear();
  mocks.clear.mockClear();
  mocks.invokeIpc.mockClear();
  let tail = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: vi.fn((_name: string, _options: unknown, callback: () => Promise<void>) => {
        const next = tail.then(callback);
        tail = next.catch(() => undefined);
        return next;
      }),
    },
  });
});

it("secondary windows wait for the primary migration instead of importing their empty legacy store", async () => {
  mocks.windowLabel = "stage-a-peer";
  mocks.rows.length = 0;
  mocks.imported = true;
  await migrateDownloadHistory();
  expect(mocks.getAll).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.invokeIpc).not.toHaveBeenCalledWith("import_download_history", expect.anything());
});

it("serializes concurrent first imports and clears the old source only after the committed marker", async () => {
  await Promise.all([migrateDownloadHistory(), migrateDownloadHistory()]);
  expect(mocks.invokeIpc.mock.calls.filter(([command]) => command === "import_download_history")).toHaveLength(1);
  expect(mocks.getAll).toHaveBeenCalledTimes(1);
  expect(mocks.clear).toHaveBeenCalledTimes(1);
  expect(mocks.rows).toHaveLength(0);
});

it("retains IndexedDB data after a failed import and retries on the next startup", async () => {
  mocks.failImport = true;
  await expect(migrateDownloadHistory()).rejects.toThrow("interrupted");
  expect(mocks.rows).toHaveLength(1);
  expect(mocks.clear).not.toHaveBeenCalled();
  mocks.failImport = false;
  await migrateDownloadHistory();
  expect(mocks.rows).toHaveLength(1);
  await migrateDownloadHistory();
  expect(mocks.rows).toHaveLength(0);
});

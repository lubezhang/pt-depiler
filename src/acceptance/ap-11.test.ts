import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getAll: vi.fn(),
  clear: vi.fn(),
  label: "main",
  hasJournal: true,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: mocks.label }) }));
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({
  ptdIndexDb: Promise.resolve({
    objectStoreNames: { contains: () => mocks.hasJournal },
    getAll: mocks.getAll,
    clear: mocks.clear,
  }),
}));
import { importLegacyRestoreJournals } from "@/offscreen/adapter/downloadHistory.ts";

beforeEach(() => {
  mocks.label = "main";
  mocks.hasJournal = true;
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.getAll.mockReset().mockResolvedValue([]);
  mocks.clear.mockReset().mockResolvedValue(undefined);
});

it("AP-11 failed import preserves legacy journals; cleanup occurs only after commit", async () => {
  const journal = { id: "old-1", stage: "prepared", before: { config: {} }, after: { config: {} } };
  mocks.getAll.mockImplementation(async (store) => (store === "restore_journal" ? [journal] : []));
  mocks.invoke.mockRejectedValueOnce({ code: "STORAGE_RECOVERY_REQUIRED" });
  await expect(importLegacyRestoreJournals()).rejects.toMatchObject({ code: "STORAGE_RECOVERY_REQUIRED" });
  expect(mocks.clear).not.toHaveBeenCalled();
  await importLegacyRestoreJournals();
  expect(mocks.invoke).toHaveBeenLastCalledWith("import_legacy_restore_journals", {
    journals: [journal],
    histories: [],
  });
  expect(mocks.clear).toHaveBeenCalledWith("restore_journal");
  expect(mocks.clear.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.invoke.mock.invocationCallOrder[1]);
});

it("AP-11 interrupted cleanup retries committed import and cleanup on next startup", async () => {
  const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.clear.mockRejectedValueOnce(new Error("injected cleanup failure"));
  try {
    await importLegacyRestoreJournals();
    await importLegacyRestoreJournals();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.clear).toHaveBeenCalledTimes(2);
    expect(diagnostic).toHaveBeenCalledWith("[restore] Legacy journal cleanup will retry at next startup");
  } finally {
    diagnostic.mockRestore();
  }
});

it("AP-11 absent store still commits startup marker; peer never imports or clears old source", async () => {
  mocks.hasJournal = false;
  await importLegacyRestoreJournals();
  expect(mocks.invoke).toHaveBeenCalledWith("import_legacy_restore_journals", { journals: [], histories: [] });
  expect(mocks.getAll).not.toHaveBeenCalled();
  mocks.label = "stage-a-peer";
  mocks.invoke.mockResolvedValue({ imports: { legacyRestoreJournal: {} } });
  await importLegacyRestoreJournals();
  expect(mocks.invoke).toHaveBeenLastCalledWith("get_storage_status", {});
  expect(mocks.clear).not.toHaveBeenCalled();
});

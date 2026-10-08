import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { extStorage } from "../entries/storage.ts";

beforeEach(() => invoke.mockReset());

describe("AP-02 conditional root writes", () => {
  it("carries the read snapshot and adopts the committed merge result", async () => {
    invoke.mockResolvedValueOnce({ sites: { alpha: { name: "A" } }, lastSearchFilter: "" });
    invoke.mockResolvedValueOnce({ sites: { alpha: { name: "A" }, beta: { name: "B" } }, lastSearchFilter: "new" });
    const metadata = await extStorage.getItem("metadata");
    expect(metadata).not.toBeNull();
    metadata!.lastSearchFilter = "new";
    await extStorage.setItem("metadata", metadata!);

    expect(invoke).toHaveBeenNthCalledWith(2, "merge_ext_storage", {
      key: "metadata",
      base: { sites: { alpha: { name: "A" } }, lastSearchFilter: "" },
      value: { sites: { alpha: { name: "A" } }, lastSearchFilter: "new" },
    });
    expect(metadata!.sites).toHaveProperty("beta");
    expect(invoke.mock.calls.some(([command]) => command === "set_ext_storage")).toBe(false);
  });

  it("does not mark a failed write committed or accept an unbased root value", async () => {
    invoke.mockResolvedValueOnce({ theme: "light" });
    invoke.mockRejectedValueOnce("STORAGE_CONFLICT:merge_ext_storage");
    const config = await extStorage.getItem("config");
    config!.theme = "dark";
    await expect(extStorage.setItem("config", config!)).rejects.toBe("STORAGE_CONFLICT:merge_ext_storage");
    expect(config!.theme).toBe("dark");
    await expect(extStorage.setItem("config", { ...config! })).rejects.toThrow("STORAGE_CONDITIONAL_WRITE_REQUIRED");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

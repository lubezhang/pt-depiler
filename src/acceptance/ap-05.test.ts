import { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getItem: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem } }));

import { createTauriAdapter, invalidateHostMapCache } from "../extends/axios/tauriAdapter.ts";

describe("AP-05 HTTP identity boundary", () => {
  it("sends only the resource ID and target URL to Rust", async () => {
    invalidateHostMapCache();
    mocks.getItem.mockResolvedValue({ siteHostMap: { "tracker.example": "tracker" } });
    mocks.invoke.mockResolvedValue({ status: 200, headers: {}, body: "ok", finalUrl: "https://tracker.example/" });
    const adapter = createTauriAdapter({ kind: "site", resourceId: "tracker" });
    await adapter({
      url: "https://tracker.example/",
      method: "get",
      headers: new AxiosHeaders(),
    } as InternalAxiosRequestConfig);
    const payload = mocks.invoke.mock.calls[0][1].req;
    expect(payload.siteId).toBe("tracker");
    expect(payload).not.toHaveProperty("resourceEndpoint");
    expect(payload).not.toHaveProperty("resourceKind");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getItem: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem } }));

import { invalidateHostMapCache } from "~/extends/axios/tauriAdapter.ts";
import { socialHttpClient } from "~/extends/axios/resourceClient.ts";
import { getSocialRecommendations } from "./recommendations.ts";

interface IpcRequest {
  siteId: string;
  url: string;
  binary: boolean;
}

describe("热门推荐请求", () => {
  beforeEach(() => {
    invalidateHostMapCache();
    mocks.getItem.mockReset().mockResolvedValue({ siteHostMap: {} });
    mocks.invoke.mockReset().mockImplementation(async (command: string, payload: { req: IpcRequest }) => {
      expect(command).toBe("ptd_fetch");
      const { req } = payload;
      const url = new URL(req.url);
      const data = url.pathname.includes("subject_collection")
        ? { subject_collection_items: [{ id: "100", title: "合集作品" }] }
        : { subjects: [{ id: "200", title: "热门作品" }] };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
        finalUrl: req.url,
      };
    });
  });

  it("通过 Tauri 获取四类推荐，并为不同来源域名分配独立身份", async () => {
    const result = await getSocialRecommendations({ flush: true });

    expect(result.hasFailedSources).toBe(false);
    expect(new Set(result.items.map((item) => item.category))).toEqual(new Set(["movie", "tv", "variety", "anime"]));
    expect(result.items.every((item) => item.id && item.title)).toBe(true);

    const requests = mocks.invoke.mock.calls.map(([, payload]) => payload.req as IpcRequest);
    expect(requests).toHaveLength(10);
    expect(requests.every((req) => !("resourceEndpoint" in req) && !("resourceKind" in req))).toBe(true);
    const identities = new Map(requests.map((req) => [new URL(req.url).origin, req.siteId]));
    expect(identities.size).toBe(2);
    expect(new Set(identities.values()).size).toBe(2);
    expect(requests.every((req) => req.siteId === identities.get(new URL(req.url).origin))).toBe(true);
  });

  it("海报请求保留二进制响应", async () => {
    const url = "https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg";
    mocks.invoke.mockResolvedValue({
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: btoa("poster"),
      finalUrl: url,
    });

    const response = await socialHttpClient(url).get<Blob>(url, { responseType: "blob" });

    expect(response.data).toBeInstanceOf(Blob);
    expect(response.data.type).toBe("image/jpeg");
    expect(response.data.size).toBe(6);
    expect(mocks.invoke.mock.calls[0][1].req.binary).toBe(true);
  });
});

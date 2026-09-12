import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("../utils/adapter", () => ({
  axios: {
    request: mocks.request,
  },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: vi.fn(),
  sleep: vi.fn(),
  store: vi.fn(),
}));

import PrivateSite from "../schemas/AbstractPrivateSite";
import type { ISiteMetadata } from "../types";

describe("BittorrentSite.request", () => {
  beforeEach(() => {
    mocks.request.mockReset();
  });

  it("保留没有 HTTP response 的底层传输错误", async () => {
    const transportError = new Error("transport failure");
    mocks.request.mockRejectedValue(transportError);
    const site = new PrivateSite(
      {
        id: "fixture-site",
        name: "Fixture Site",
        type: "private",
        schema: "NexusPHP",
        urls: ["https://tracker.example/"],
        version: 1,
      } as ISiteMetadata,
      {},
    );

    await expect(site.request({ url: "/", responseType: "document" })).rejects.toBe(transportError);
  });
});

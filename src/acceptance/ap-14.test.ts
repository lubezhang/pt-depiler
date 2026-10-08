import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  invoke: vi.fn(),
  sendMessage: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/messages.ts", () => ({
  onMessage: (name: string, handler: Function) => mocks.handlers.set(name, handler),
  sendMessage: mocks.sendMessage,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: async () => ({ siteHostMap: {} }) } }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: vi.fn() }));
vi.mock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: mocks.create }));
import "@/offscreen/utils/search.ts";
import { getSite } from "@ptd/site";
import { siteDependencies } from "@/offscreen/adapter/site.ts";
import { InMemoryLogger } from "~/domain/ports/index.ts";

it("AP-14 non-search site request uses injected HTTP and clock", async () => {
  const ports = siteDependencies("nyaa");
  const http = vi
    .spyOn(ports.http, "request")
    .mockResolvedValue({ data: new DOMParser().parseFromString("<html></html>", "text/html"), status: 200 });
  const now = vi.fn(() => 1000);
  ports.clock = { now, sleep: vi.fn() };
  const logger = new InMemoryLogger();
  ports.logger = logger;
  const site = await getSite("nyaa", {}, ports);
  site.metadata.requestDelay = 321;
  await site.request({ url: "/non-search", responseType: "document" });
  expect(http).toHaveBeenCalledWith(expect.objectContaining({ url: "/non-search" }));
  expect(ports.clock.sleep).toHaveBeenCalledWith(321);
  await site.getSearchResult("fixture");
  expect(logger.records).toEqual(expect.arrayContaining([expect.objectContaining({ message: "site search" })]));
});

it("AP-14 production search factory routes HTTP, settings and logger through supplied ports", async () => {
  mocks.sendMessage.mockResolvedValue({ searchEntity: {}, sites: { fixture: { url: "https://tracker.example/" } } });
  mocks.invoke.mockResolvedValue({
    status: 200,
    statusText: "OK",
    headers: {},
    body: "{}",
    binary: false,
    finalUrl: "https://tracker.example/",
  });
  mocks.create.mockImplementation(async (id, options) => {
    const ports = options.dependencies;
    expect(await ports.settings.read("metadata", "sites.fixture.url")).toBe("https://tracker.example/");
    return {
      metadata: {},
      getSearchResult: async () => {
        await ports.http.request({ method: "GET", url: "https://tracker.example/", responseType: "json" });
        ports.logger.info("fixture search");
        return { data: [], status: 0 };
      },
    };
  });
  await mocks.handlers.get("getSiteSearchResult")!({ data: { siteId: "fixture", keyword: "test" } });
  expect(mocks.invoke).toHaveBeenCalledWith(
    "ptd_fetch",
    expect.objectContaining({ req: expect.objectContaining({ siteId: "site:fixture" }) }),
  );
  expect(mocks.sendMessage).toHaveBeenCalledWith("getExtStorage", "metadata");
});

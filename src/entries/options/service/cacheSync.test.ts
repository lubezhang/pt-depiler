import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revision: 1,
  config: { $onReady: vi.fn(async () => undefined), $adoptCommitted: vi.fn(async () => true) },
  metadata: { $onReady: vi.fn(async () => undefined), $adoptCommitted: vi.fn(async () => true) },
}));

vi.mock("~/extends/tauri/ipc.ts", () => ({
  invokeIpc: vi.fn(async () => ({
    revision: mocks.revision,
    config: { theme: `theme-${mocks.revision}` },
    metadata: { sites: { [`site-${mocks.revision}`]: {} } },
  })),
}));
vi.mock("../stores/config.ts", () => ({ useConfigStore: () => mocks.config }));
vi.mock("../stores/metadata.ts", () => ({ useMetadataStore: () => mocks.metadata }));

import { refreshResourceCache, startResourceCacheSync } from "./cacheSync.ts";

beforeEach(() => {
  mocks.revision = 1;
  mocks.config.$adoptCommitted.mockClear();
  mocks.metadata.$adoptCommitted.mockClear();
});

it("rebuilds persistent caches on focus after a missed notification and ignores the old revision", async () => {
  await refreshResourceCache({} as never, true);
  const stop = startResourceCacheSync({} as never);
  try {
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(mocks.config.$adoptCommitted).toHaveBeenCalledTimes(1));
    mocks.revision = 2;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(mocks.config.$adoptCommitted).toHaveBeenCalledTimes(2));
    expect(mocks.config.$adoptCommitted).toHaveBeenLastCalledWith({ theme: "theme-2" });
    expect(mocks.metadata.$adoptCommitted).toHaveBeenLastCalledWith({ sites: { "site-2": {} } });
    mocks.revision = 1;
    window.dispatchEvent(new Event("focus"));
    await refreshResourceCache({} as never);
    expect(mocks.config.$adoptCommitted).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

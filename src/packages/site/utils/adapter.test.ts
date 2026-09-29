import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  legacySiteHttp: { request: vi.fn() },
}));

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn() }));
vi.mock("~/extends/axios/resourceClient.ts", () => ({ legacySiteHttp: mocks.legacySiteHttp }));

import { axios } from "./adapter.ts";

it("站点请求使用 Tauri 资源客户端", () => {
  expect(axios).toBe(mocks.legacySiteHttp);
});

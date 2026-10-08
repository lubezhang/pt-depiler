import { expect, it } from "vitest";
import * as adapter from "./adapter.ts";
it("站点包兼容出口不提供隐式 HTTP 或存储客户端", () => {
  expect(Object.keys(adapter).sort()).toEqual(["isCloudflareBlocked", "sleep"]);
});

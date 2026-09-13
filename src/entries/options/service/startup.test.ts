import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fixAllStoredUserInfo: vi.fn() }));

vi.mock("@/background/utils/fixer.ts", () => ({ fixAllStoredUserInfo: mocks.fixAllStoredUserInfo }));

import { startStoredUserInfoRepair } from "./startup.ts";

beforeEach(() => {
  mocks.fixAllStoredUserInfo.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("服务启动修复", () => {
  it("存储修复 rejected 时由启动入口输出诊断且不产生未处理拒绝", async () => {
    const error = new Error("user info storage unavailable");
    mocks.fixAllStoredUserInfo.mockRejectedValue(error);

    expect(() => startStoredUserInfoRepair()).not.toThrow();
    await Promise.resolve();

    expect(console.error).toHaveBeenCalledWith("[startup] Failed to repair stored user information", error);
  });
});

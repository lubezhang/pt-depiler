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
  it("存储修复失败时阻断启动且不输出原始异常", async () => {
    const error = new Error("user info storage unavailable");
    mocks.fixAllStoredUserInfo.mockRejectedValue(error);

    await expect(startStoredUserInfoRepair()).rejects.toBe(error);

    expect(console.error).not.toHaveBeenCalled();
  });
});

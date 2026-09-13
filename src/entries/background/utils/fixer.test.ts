import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));

vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem, setItem: mocks.setItem } }));

import { fixAllStoredUserInfo } from "./fixer.ts";

describe("启动用户信息修复", () => {
  beforeEach(() => {
    mocks.getItem.mockReset();
    mocks.setItem.mockReset();
  });

  it("存储读取失败时向启动入口传播错误", async () => {
    const error = new Error("user info storage unavailable");
    mocks.getItem.mockRejectedValue(error);

    await expect(fixAllStoredUserInfo()).rejects.toBe(error);
  });
});

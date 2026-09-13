import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  invoke: vi.fn(),
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem } }));

import { checkAndExtendCookies } from "./cookies.ts";

beforeEach(() => {
  mocks.getItem.mockReset();
  mocks.invoke.mockReset();
  mocks.onMessage.mockReset();
  mocks.sendMessage.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cookie 自动续期诊断", () => {
  it("记录 cookie 续期失败时 logger 再次失败会回退到控制台", async () => {
    const loggerError = new Error("logger unavailable");
    mocks.getItem.mockResolvedValue({
      autoExtendCookies: { enabled: true, triggerThreshold: 1, extensionDuration: 1 },
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_cookies") {
        return Promise.resolve([{ name: "c_secure_session", expirationDate: Math.floor(Date.now() / 1000) }]);
      }
      return Promise.reject(new Error("set cookie failed"));
    });
    mocks.sendMessage.mockRejectedValue(loggerError);

    await checkAndExtendCookies("https://tracker.test/path?token=secret");
    await Promise.resolve();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to record cookie diagnostic: Failed to extend cookie c_secure_session"),
      loggerError,
    );
  });
});

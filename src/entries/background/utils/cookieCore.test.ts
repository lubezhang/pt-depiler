import { describe, expect, it } from "vitest";

import { redactCookieUrl, toChromeCookie, toCookieInfo } from "./cookieCore.ts";

describe("CookieInfo 转换", () => {
  it("恢复没有 url 的备份 Cookie，并保留 host-only 作用域", () => {
    const restored = toCookieInfo({
      name: "session",
      value: "secret",
      domain: "tracker.example",
      hostOnly: true,
      path: "/account",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 4_102_444_800,
    } as chrome.cookies.SetDetails & { hostOnly: boolean });

    expect(restored).toEqual({
      name: "session",
      value: "secret",
      domain: "tracker.example",
      hostOnly: true,
      path: "/account",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 4_102_444_800,
    });
  });

  it("从 cookies.set 的 url 推导 host-only domain", () => {
    expect(
      toCookieInfo({
        url: "https://tracker.example/account/login.php",
        name: "session",
        value: "value",
      }),
    ).toMatchObject({ domain: "tracker.example", hostOnly: true, path: "/" });
  });

  it("往返保留 Domain Cookie 与 SameSite=None", () => {
    const cookie = toChromeCookie({
      name: "shared",
      value: "value",
      domain: ".tracker.example",
      hostOnly: false,
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "none",
    });

    expect(toCookieInfo(cookie as unknown as chrome.cookies.SetDetails)).toMatchObject({
      domain: ".tracker.example",
      hostOnly: false,
      sameSite: "none",
    });
  });

  it("拒绝无法确定作用域的 Cookie", () => {
    expect(() => toCookieInfo({ name: "session", value: "value" } as unknown as chrome.cookies.SetDetails)).toThrow(
      "缺少 domain 或 url",
    );
  });

  it("日志 URL 不保留查询参数和用户信息", () => {
    expect(redactCookieUrl("https://user:pass@tracker.example/path?token=secret#fragment")).toBe(
      "https://tracker.example",
    );
  });
});

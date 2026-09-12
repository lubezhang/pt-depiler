import axios from "axios";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSite: vi.fn(),
  invoke: vi.fn(),
  sendMessage: vi.fn(),
  NeedLoginError: class NeedLoginError extends Error {},
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/messages.ts", () => ({ sendMessage: mocks.sendMessage }));
vi.mock("@ptd/site", () => ({ getSite: mocks.getSite, NeedLoginError: mocks.NeedLoginError }));

import nexusLogin from "./fixtures/nexus-login.html?raw";
import {
  finishInteractiveSiteLogin,
  getCaptchaImage,
  loginSite,
  openInteractiveSiteLogin,
  prepareSiteLogin,
  type PreparedSiteLogin,
  type SiteLoginInput,
} from "./siteLogin.ts";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function response(data: Document | Blob, status: number, responseUrl: string, headers: Record<string, string> = {}) {
  return {
    data,
    status,
    statusText: "",
    headers,
    config: { url: responseUrl },
    request: { responseURL: responseUrl },
  };
}

function preparedLogin(): PreparedSiteLogin {
  return {
    captcha: { fieldName: "imagestring", imageUrl: "https://tracker.example/image.php?id=123" },
    form: {
      action: "https://tracker.example/takelogin.php?returnto=%2Ftorrents.php",
      method: "post",
      usernameField: "username",
      passwordField: "password",
      rememberField: { name: "keep_login", value: "yes" },
      fields: new URLSearchParams({ csrf_token: "fixture-token" }),
    },
  };
}

function loginInput(): SiteLoginInput {
  return {
    siteId: "fixture-site" as never,
    siteUrl: "https://tracker.example/",
    schema: "NexusPHP",
    username: "alice",
    password: "plain-secret",
    remember: true,
  };
}

const axiosGet = vi.spyOn(axios, "get");
const axiosRequest = vi.spyOn(axios, "request");
const originalCreateObjectUrl = URL.createObjectURL;

afterAll(() => {
  if (originalCreateObjectUrl) {
    URL.createObjectURL = originalCreateObjectUrl;
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  axiosGet.mockReset();
  axiosRequest.mockReset();
  mocks.getSite.mockReset();
  mocks.invoke.mockReset();
  mocks.sendMessage.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
});

describe("prepareSiteLogin", () => {
  it("首次 400 时只重试幂等登录页，并解析最新 token、相对 action 与验证码", async () => {
    vi.useFakeTimers();
    axiosGet
      .mockResolvedValueOnce(response(parse("<title>temporary</title>"), 400, "https://tracker.example/login.php"))
      .mockResolvedValueOnce(response(parse(nexusLogin), 200, "https://tracker.example/auth/login.php"));

    const preparing = prepareSiteLogin({
      siteUrl: "https://tracker.example/",
      schema: "NexusPHP",
      loginPath: "/auth/login.php",
    });
    await vi.advanceTimersByTimeAsync(500);
    const prepared = await preparing;
    expect(axiosGet).toHaveBeenCalledTimes(2);
    expect(axiosGet).toHaveBeenNthCalledWith(
      1,
      "https://tracker.example/auth/login.php",
      expect.objectContaining({ responseType: "document" }),
    );
    expect(prepared.form.action).toBe("https://tracker.example/takelogin.php?returnto=%2Ftorrents.php");
    expect(prepared.form.fields.get("csrf_token")).toBe("nexus-token");
    expect(prepared.captcha).toEqual({
      fieldName: "imagestring",
      imageUrl: "https://tracker.example/image.php?id=123",
    });
  });
});

describe("应用内站点页面登录", () => {
  it("打开 schema 默认登录页", async () => {
    await openInteractiveSiteLogin({ siteUrl: "https://tracker.example/", schema: "Unit3D" });

    expect(mocks.invoke).toHaveBeenCalledWith("open_site_login", {
      siteUrl: "https://tracker.example/",
      loginUrl: "https://tracker.example/login",
    });
  });

  it("同步原生 WebView Cookie 后验证真实登录态", async () => {
    const siteRequest = vi.fn().mockResolvedValue({});
    mocks.invoke.mockResolvedValueOnce(2);
    mocks.getSite.mockResolvedValue({ request: siteRequest });

    await expect(
      finishInteractiveSiteLogin({
        siteId: "fixture-site" as never,
        siteUrl: "https://tracker.example/",
        schema: "NexusPHP",
      }),
    ).resolves.toEqual({ cookieCount: 2, finalUrl: "https://tracker.example/" });

    expect(mocks.invoke).toHaveBeenCalledWith("finish_site_login", { siteUrl: "https://tracker.example/" });
    expect(siteRequest).toHaveBeenCalledWith({ url: "/", responseType: "document" });
  });

  it("同步后的首次登录态校验返回 400 时重试一次", async () => {
    vi.useFakeTimers();
    const siteRequest = vi.fn().mockRejectedValueOnce(new Error("Network Error: 400")).mockResolvedValueOnce({});
    mocks.invoke.mockResolvedValueOnce(5);
    mocks.getSite.mockResolvedValue({ request: siteRequest });

    const finishing = finishInteractiveSiteLogin({
      siteId: "fixture-site" as never,
      siteUrl: "https://tracker.example/",
      schema: "NexusPHP",
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(finishing).resolves.toEqual({ cookieCount: 5, finalUrl: "https://tracker.example/" });
    expect(siteRequest).toHaveBeenCalledTimes(2);
  });

  it("WebView 没有 Cookie 时拒绝伪成功", async () => {
    mocks.invoke.mockResolvedValueOnce(0);

    await expect(
      finishInteractiveSiteLogin({
        siteId: "fixture-site" as never,
        siteUrl: "https://tracker.example/",
      }),
    ).rejects.toThrow("没有从站点登录窗口获取到 Cookie");
    expect(mocks.getSite).not.toHaveBeenCalled();
  });
});

describe("getCaptchaImage", () => {
  it("只接受非空图片响应并生成对象 URL", async () => {
    const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const createObjectUrl = vi.fn().mockReturnValue("blob:captcha");
    URL.createObjectURL = createObjectUrl;
    axiosGet.mockResolvedValue(
      response(image, 200, "https://tracker.example/image.php?id=123", {
        "content-type": "image/png",
      }),
    );

    await expect(getCaptchaImage(preparedLogin())).resolves.toBe("blob:captcha");
    expect(createObjectUrl).toHaveBeenCalledWith(image);
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("id=123");
  });

  it("拒绝伪装成验证码的文本响应", async () => {
    const invalid = new Blob(["not-an-image"], { type: "text/plain" });
    axiosGet.mockResolvedValue(
      response(invalid, 200, "https://tracker.example/image.php", {
        "content-type": "text/plain",
      }),
    );

    await expect(getCaptchaImage(preparedLogin())).rejects.toThrow("验证码图片响应不是有效图片");
  });
});

describe("loginSite", () => {
  it("提交一次性密码字段后校验 Cookie、最终 URL 和站点登录态，日志不含密码", async () => {
    const siteRequest = vi
      .fn()
      .mockResolvedValue(response(parse("<title>home</title>"), 200, "https://tracker.example/"));
    axiosRequest.mockResolvedValue(
      response(parse("<title>Dashboard</title>"), 200, "https://tracker.example/index.php?welcome=1"),
    );
    mocks.sendMessage.mockResolvedValue([{ name: "session" }]);
    mocks.getSite.mockResolvedValue({ request: siteRequest });

    await expect(loginSite(loginInput(), preparedLogin(), " 1234 ")).resolves.toEqual({
      cookieCount: 1,
      finalUrl: "https://tracker.example/index.php?welcome=1",
    });

    const submitted = axiosRequest.mock.calls[0][0];
    expect(submitted.method).toBe("post");
    expect(submitted.url).toBe("https://tracker.example/takelogin.php?returnto=%2Ftorrents.php");
    expect(Object.fromEntries(submitted.data as URLSearchParams)).toMatchObject({
      csrf_token: "fixture-token",
      username: "alice",
      password: "plain-secret",
      keep_login: "yes",
      imagestring: "1234",
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith("getAllCookies", { domain: "tracker.example" });
    expect(mocks.getSite).toHaveBeenCalledWith("fixture-site", { url: "https://tracker.example/" });
    expect(siteRequest).toHaveBeenCalledWith({ url: "/", responseType: "document" });
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("plain-secret");
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("welcome=1");
  });

  it("GET 登录表单保留同名隐藏字段", async () => {
    const prepared = preparedLogin();
    prepared.captcha = undefined;
    prepared.form.method = "get";
    prepared.form.fields.append("scope", "read");
    prepared.form.fields.append("scope", "write");
    axiosRequest.mockResolvedValue(response(parse("<title>Dashboard</title>"), 200, "https://tracker.example/"));
    mocks.sendMessage.mockResolvedValue([{ name: "session" }]);
    mocks.getSite.mockResolvedValue({ request: vi.fn().mockResolvedValue({}) });

    await expect(loginSite(loginInput(), prepared)).resolves.toMatchObject({ cookieCount: 1 });

    const submitted = axiosRequest.mock.calls[0][0];
    expect(submitted.method).toBe("get");
    expect(submitted.data).toBeUndefined();
    expect((submitted.params as URLSearchParams).getAll("scope")).toEqual(["read", "write"]);
  });

  it("Cookie 存在但站点仍要求登录时返回明确失败", async () => {
    axiosRequest.mockResolvedValue(response(parse("<title>Dashboard</title>"), 200, "https://tracker.example/"));
    mocks.sendMessage.mockResolvedValue([{ name: "unrelated-cookie" }]);
    mocks.getSite.mockResolvedValue({
      request: vi.fn().mockRejectedValue(new mocks.NeedLoginError("login required")),
    });

    await expect(loginSite(loginInput(), preparedLogin(), "1234")).rejects.toThrow("站点仍返回未登录状态");
  });

  it("没有取得 Cookie 时不执行站点接口校验", async () => {
    axiosRequest.mockResolvedValue(response(parse("<title>Dashboard</title>"), 200, "https://tracker.example/"));
    mocks.sendMessage.mockResolvedValue([]);

    await expect(loginSite(loginInput(), preparedLogin(), "1234")).rejects.toThrow("登录请求未获取到 Cookie");
    expect(mocks.getSite).not.toHaveBeenCalled();
  });
});

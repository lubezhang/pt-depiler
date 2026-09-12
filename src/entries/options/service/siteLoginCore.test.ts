import { describe, expect, it } from "vitest";

import nexusLogin from "./fixtures/nexus-login.html?raw";
import ssoLogin from "./fixtures/sso-login.html?raw";
import unit3dLogin from "./fixtures/unit3d-login.html?raw";
import { buildLoginSubmissionFields, findLoginForm, validateLoginResponsePage } from "./siteLoginCore.ts";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("findLoginForm", () => {
  it("解析 NexusPHP 隐藏字段、相对 action、remember 和验证码", () => {
    const prepared = findLoginForm(parse(nexusLogin), "https://tracker.example/auth/login.php");

    expect(prepared.form).toMatchObject({
      action: "https://tracker.example/takelogin.php?returnto=%2Ftorrents.php",
      method: "post",
      usernameField: "username",
      passwordField: "password",
      rememberField: { name: "keep_login", value: "yes" },
    });
    expect(Object.fromEntries(prepared.form.fields)).toEqual({
      csrf_token: "nexus-token",
      returnto: "/torrents.php",
    });
    expect(prepared.captcha).toEqual({
      fieldName: "imagestring",
      imageUrl: "https://tracker.example/image.php?id=123",
    });
  });

  it("解析 Unit3D email 登录和相对 action", () => {
    const prepared = findLoginForm(parse(unit3dLogin), "https://unit3d.example/login");

    expect(prepared.form).toMatchObject({
      action: "https://unit3d.example/authenticate",
      usernameField: "email",
      passwordField: "password",
      rememberField: { name: "remember", value: "on" },
    });
    expect(prepared.form.fields.get("_token")).toBe("unit3d-token");
    expect(prepared.captcha).toBeUndefined();
  });

  it("为复杂 SSO 提供明确替代登录提示", () => {
    expect(() => findLoginForm(parse(ssoLogin), "https://sso.example/login")).toThrow(
      "该站点可能使用单点登录或其他非表单登录方式",
    );
  });

  it("为每次提交复制字段，不把密码写入准备态", () => {
    const prepared = findLoginForm(parse(nexusLogin), "https://tracker.example/auth/login.php");
    const before = prepared.form.fields.toString();

    const fields = buildLoginSubmissionFields(prepared, {
      username: "alice",
      password: "plain-secret",
      remember: true,
      captcha: " 1234 ",
    });

    expect(Object.fromEntries(fields)).toMatchObject({
      username: "alice",
      password: "plain-secret",
      keep_login: "yes",
      imagestring: "1234",
    });
    expect(prepared.form.fields.toString()).toBe(before);
    expect(prepared.form.fields.has("password")).toBe(false);
  });
});

describe("validateLoginResponsePage", () => {
  it("接受本站登录后的最终页面", () => {
    expect(
      validateLoginResponsePage(
        parse("<!doctype html><title>Dashboard</title>"),
        "https://tracker.example/index.php?welcome=1",
        "https://tracker.example/",
      ),
    ).toBe("https://tracker.example/index.php?welcome=1");
  });

  it("拒绝最终页面仍含登录表单", () => {
    expect(() =>
      validateLoginResponsePage(parse(nexusLogin), "https://tracker.example/login.php", "https://tracker.example/"),
    ).toThrow("最终页面仍显示账号密码表单");
  });

  it("拒绝跳转到无关域名或无效最终地址", () => {
    expect(() =>
      validateLoginResponsePage(parse("<p>redirected</p>"), "https://evil.example/", "https://tracker.example/"),
    ).toThrow("非本站地址");
    expect(() => validateLoginResponsePage(parse("<p>ok</p>"), "not a url", "https://tracker.example/")).toThrow(
      "未返回有效的最终地址",
    );
  });
});

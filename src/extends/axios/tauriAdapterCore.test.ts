import axios, { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  buildRequestUrl,
  createAxiosResponse,
  decodeResponseBody,
  headersToRecord,
  serializeRequestBody,
  toAxiosTransportError,
  withCancellation,
} from "./tauriAdapterCore.ts";

function config(overrides: Partial<InternalAxiosRequestConfig> = {}): InternalAxiosRequestConfig {
  return {
    headers: new AxiosHeaders(),
    method: "get",
    url: "/api",
    validateStatus: (status) => status >= 200 && status < 300,
    ...overrides,
  } as InternalAxiosRequestConfig;
}

describe("buildRequestUrl", () => {
  it("保留已有查询参数并按 Axios 默认规则编码数组", () => {
    const url = buildRequestUrl(
      config({
        baseURL: "https://tracker.example/root/",
        url: "/api?existing=1",
        params: { tags: ["中文", "1080p"], empty: null },
      }),
    );

    expect(url).toBe("https://tracker.example/root/api?existing=1&tags%5B%5D=%E4%B8%AD%E6%96%87&tags%5B%5D=1080p");
  });

  it("使用调用方提供的 paramsSerializer", () => {
    const url = buildRequestUrl(
      config({
        baseURL: "https://tracker.example",
        params: { ids: [1, 2] },
        paramsSerializer: { serialize: () => "ids=1%2C2" },
      }),
    );

    expect(url).toBe("https://tracker.example/api?ids=1%2C2");
  });
});

describe("serializeRequestBody", () => {
  it("区分空请求体、文本和二进制", async () => {
    await expect(serializeRequestBody(undefined, {})).resolves.toEqual({ body: { kind: "none" }, headers: {} });
    await expect(serializeRequestBody("a=1", {})).resolves.toEqual({
      body: { kind: "text", data: "a=1" },
      headers: {},
    });
    await expect(serializeRequestBody(new Uint8Array([0, 255, 16]), {})).resolves.toEqual({
      body: { kind: "base64", data: "AP8Q" },
      headers: {},
    });
  });

  it("编码 FormData 的 boundary、字段、文件名、MIME 和原始字节", async () => {
    const form = new FormData();
    form.append("token", "hello");
    form.append(
      "torrent",
      new File([new Uint8Array([0, 255, 16])], "sample.torrent", { type: "application/x-bittorrent" }),
    );

    const result = await serializeRequestBody(form, { "Content-Type": "application/x-www-form-urlencoded" });
    expect(result.body.kind).toBe("base64");
    expect(result.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);

    const raw = atob(result.body.kind === "base64" ? result.body.data : "");
    expect(raw).toContain('name="token"');
    expect(raw).toContain("hello");
    expect(raw).toContain('filename="sample.torrent"');
    expect(raw).toContain("Content-Type: application/x-bittorrent");
    expect(Array.from(raw.slice(-3), (value) => value.charCodeAt(0))).not.toEqual([0, 255, 16]);
    expect(raw).toContain(String.fromCharCode(0, 255, 16));
  });

  it("保留 URLSearchParams 的表单编码，不发生二次转义", async () => {
    const result = await serializeRequestBody(new URLSearchParams({ username: "a+b", password: "中 文" }), {});

    expect(result.body).toEqual({
      kind: "text",
      data: "username=a%2Bb&password=%E4%B8%AD+%E6%96%87",
    });
  });
});

describe("请求头契约", () => {
  it("按 UTF-8 生成 Axios auth 的 Basic Authorization", () => {
    const headers = headersToRecord(new AxiosHeaders(), { username: "用户", password: "p@ss" });
    const encoded = headers.Authorization.slice("Basic ".length);

    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0)))).toBe("用户:p@ss");
  });
});

describe("响应与错误契约", () => {
  it("无损解码二进制响应", () => {
    expect(new Uint8Array(decodeResponseBody("AP8Q", "arraybuffer") as ArrayBuffer)).toEqual(
      new Uint8Array([0, 255, 16]),
    );
  });

  it("Blob 响应保留服务端 MIME 类型", () => {
    const blob = decodeResponseBody("iVBORw==", "blob", "image/png") as Blob;

    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(4);
  });

  it("种子响应解码前后的 SHA-256 一致", () => {
    const torrentBytes = new Uint8Array([
      100, 52, 58, 105, 110, 102, 111, 100, 52, 58, 110, 97, 109, 101, 54, 58, 115, 97, 109, 112, 108, 101, 101, 0, 255,
      16,
    ]);
    const encoded = btoa(String.fromCharCode(...torrentBytes));
    const decoded = new Uint8Array(decodeResponseBody(encoded, "arraybuffer") as ArrayBuffer);
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

    expect(digest(decoded)).toBe(digest(torrentBytes));
  });

  it("将 Rust 超时和普通传输错误映射为 Axios 错误码", () => {
    expect(toAxiosTransportError("请求超时: deadline", config()).code).toBe("ECONNABORTED");
    expect(toAxiosTransportError("connection refused", config()).code).toBe("ERR_NETWORK");
    expect(toAxiosTransportError("请求已取消", config()).code).toBe("ERR_CANCELED");
  });

  it("支持 AbortSignal 和 CancelToken 取消", async () => {
    const controller = new AbortController();
    const signalRequest = withCancellation(new Promise<string>(() => undefined), config({ signal: controller.signal }));
    controller.abort();
    await expect(signalRequest).rejects.toMatchObject({ code: "ERR_CANCELED", isAxiosError: true });

    const source = axios.CancelToken.source();
    const tokenRequest = withCancellation(new Promise<string>(() => undefined), config({ cancelToken: source.token }));
    source.cancel("stopped");
    await expect(tokenRequest).rejects.toMatchObject({ code: "ERR_CANCELED", message: "stopped" });
  });

  it("取消时只通知后端一次，且通知失败不覆盖取消错误", async () => {
    const controller = new AbortController();
    const notify = vi.fn(() => Promise.reject(new Error("backend unavailable")));
    const request = withCancellation(
      new Promise<string>(() => undefined),
      config({ signal: controller.signal }),
      notify,
    );

    controller.abort();
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "ERR_CANCELED" });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("请求开始前已取消时仍通知后端", async () => {
    const controller = new AbortController();
    const notify = vi.fn();
    controller.abort();

    await expect(
      withCancellation(new Promise<string>(() => undefined), config({ signal: controller.signal }), notify),
    ).rejects.toMatchObject({ code: "ERR_CANCELED" });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("保留最终 URL 并构造 AxiosError", () => {
    const requestConfig = config();

    expect(() =>
      createAxiosResponse(
        {
          status: 503,
          headers: { "retry-after": "1" },
          body: "unavailable",
          finalUrl: "https://tracker.example/login.php",
        },
        requestConfig,
      ),
    ).toThrowError(
      expect.objectContaining({
        isAxiosError: true,
        code: "ERR_BAD_RESPONSE",
        response: expect.objectContaining({ status: 503 }),
        request: expect.objectContaining({ responseURL: "https://tracker.example/login.php" }),
      }),
    );
  });

  it("将 document 响应还原为 DOM", () => {
    const response = createAxiosResponse(
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<!doctype html><title>ok</title>",
        finalUrl: "https://tracker.example/",
      },
      config({ responseType: "document" }),
    );

    expect((response.data as Document).title).toBe("ok");
    expect(response.request.responseXML).toBe(response.data);
  });
});

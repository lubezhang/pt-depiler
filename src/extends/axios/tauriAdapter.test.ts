import { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getItem: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem } }));

import { invalidateHostMapCache, tauriAdapter } from "./tauriAdapter.ts";

describe("tauriAdapter IPC 接线", () => {
  beforeEach(() => {
    invalidateHostMapCache();
    mocks.invoke.mockReset();
    mocks.getItem.mockReset();
    mocks.getItem.mockResolvedValue({ siteHostMap: { "tracker.example": "tracker-id" } });
  });

  it("传递最终 URL、站点 ID、multipart 和二进制响应契约", async () => {
    mocks.invoke.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/x-bittorrent" },
      body: "AP8Q",
      finalUrl: "https://tracker.example/download/final",
    });
    const form = new FormData();
    form.append("token", "abc");
    form.append(
      "torrent",
      new File([new Uint8Array([0, 255, 16])], "sample.torrent", { type: "application/x-bittorrent" }),
    );
    const config = {
      baseURL: "https://tracker.example",
      url: "/upload?existing=1",
      method: "post",
      params: { tag: ["one", "two"] },
      headers: new AxiosHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
      data: form,
      timeout: 4_321,
      responseType: "arraybuffer",
      validateStatus: (status: number) => status >= 200 && status < 300,
    } as InternalAxiosRequestConfig;

    const response = await tauriAdapter(config);

    expect(mocks.getItem).toHaveBeenCalledWith("metadata");
    expect(mocks.invoke).toHaveBeenCalledOnce();
    const [command, payload] = mocks.invoke.mock.calls[0];
    expect(command).toBe("ptd_fetch");
    expect(payload.req).toMatchObject({
      siteId: "tracker-id",
      url: "https://tracker.example/upload?existing=1&tag%5B%5D=one&tag%5B%5D=two",
      method: "post",
      timeout: 4_321,
      binary: true,
      body: { kind: "base64" },
    });
    expect(payload.req.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const multipart = atob(payload.req.body.data);
    expect(multipart).toContain('filename="sample.torrent"');
    expect(multipart).toContain(String.fromCharCode(0, 255, 16));
    expect(new Uint8Array(response.data as ArrayBuffer)).toEqual(new Uint8Array([0, 255, 16]));
    expect(response.request.responseURL).toBe("https://tracker.example/download/final");
  });

  it("失效后重新加载 host map", async () => {
    mocks.invoke.mockResolvedValue({ status: 200, headers: {}, body: "ok", finalUrl: "https://tracker.example/" });
    const config = {
      url: "https://tracker.example/",
      method: "get",
      headers: new AxiosHeaders(),
    } as InternalAxiosRequestConfig;

    await tauriAdapter(config);
    mocks.getItem.mockResolvedValue({ siteHostMap: { "tracker.example": "updated-id" } });
    invalidateHostMapCache();
    await tauriAdapter(config);

    expect(mocks.invoke.mock.calls[0][1].req.siteId).toBe("tracker-id");
    expect(mocks.invoke.mock.calls[1][1].req.siteId).toBe("updated-id");
  });

  it("AbortSignal 取消时使用相同 requestId 通知 Rust", async () => {
    const controller = new AbortController();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "ptd_fetch") return new Promise(() => undefined);
      return Promise.resolve();
    });
    const config = {
      url: "https://tracker.example/slow",
      method: "get",
      headers: new AxiosHeaders(),
      signal: controller.signal,
    } as InternalAxiosRequestConfig;

    const request = tauriAdapter(config);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("ptd_fetch", expect.anything()));
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "ERR_CANCELED" });
    const fetchCall = mocks.invoke.mock.calls.find(([command]) => command === "ptd_fetch");
    const cancelCall = mocks.invoke.mock.calls.find(([command]) => command === "ptd_cancel_fetch");
    expect(fetchCall?.[1].req.requestId).toEqual(expect.any(String));
    expect(cancelCall?.[1].requestId).toBe(fetchCall?.[1].req.requestId);
  });
});

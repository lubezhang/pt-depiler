import { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { describe, expect, it } from "vitest";
import { toAxiosTransportError } from "../extends/axios/tauriAdapterCore.ts";

const config = { url: "https://tracker.example/", headers: new AxiosHeaders() } as InternalAxiosRequestConfig;

describe("AP-01 non-storage IPC errors", () => {
  it("maps a policy rejection by code and keeps transport details out of the UI", () => {
    const error = toAxiosTransportError(
      {
        code: "HTTP_POLICY_REJECTED",
        operationId: "fetch-42",
        message: "Bearer SENSITIVE_SENTINEL resource_endpoint=https://evil.example",
      },
      config,
    );
    expect(error.message).toBe("请求被网络策略拒绝");
    expect(error).toMatchObject({ ipcCode: "HTTP_POLICY_REJECTED", operationId: "fetch-42" });
    expect(JSON.stringify(error)).not.toContain("SENSITIVE_SENTINEL");
  });

  it("hides unknown transport failures", () => {
    expect(toAxiosTransportError("password=SENSITIVE_SENTINEL", config).message).toBe("网络请求失败");
  });
});

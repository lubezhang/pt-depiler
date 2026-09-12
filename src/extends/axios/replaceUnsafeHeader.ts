/**
 * Tauri 迁移：原浏览器环境下 axios 无法设置 Referer/Origin/Cookie 等"禁设头"，
 * 靠 chrome.declarativeNetRequest 在请求发出前替换。Tauri 下请求统一走 Rust ptd_fetch
 * （reqwest 实现，可自由设置任意头），此 setup 已无实际作用，保留为 no-op 供原调用方
 * （adapter.ts / socialRecommendations.ts / bangumi.ts）保持兼容。
 */
import type { AxiosInstance } from "axios";

export const unsafeHeaders: { [key: string]: boolean } = {
  "user-agent": true,
  cookie: true,
  "accept-charset": true,
  "accept-encoding": true,
  "access-control-request-headers": true,
  "access-control-request-method": true,
  connection: true,
  "content-length": true,
  date: true,
  dnt: true,
  expect: true,
  "feature-policy": true,
  host: true,
  "keep-alive": true,
  origin: true,
  referer: true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  via: true,
};

interface AxiosAllowUnsafeHeaderInstance extends AxiosInstance {
  defaults: AxiosInstance["defaults"] & {
    allowUnsafeHeader: boolean;
  };
}

export function setupReplaceUnsafeHeader(axios: AxiosInstance): AxiosAllowUnsafeHeaderInstance {
  return axios as AxiosAllowUnsafeHeaderInstance;
}

/**
 * Tauri 迁移：axios -> Rust ptd_fetch 适配器。
 *
 * 原扩展中，site/downloader/backupServer/social/mediaServer 等 packages 共 56 处 axios 调用，
 * 在浏览器里靠 offscreen + DNR 绕过跨域与禁设头限制。迁移到 Tauri 后，所有 axios 请求统一
 * 经此 adapter 转发到 Rust 命令 ptd_fetch（reqwest 实现、全局 RFC 6265 Cookie Store、自由设头、
 * Cloudflare 重试），packages 代码零改动。
 *
 * site_id 推导：从请求 URL 的 host 反查 metadata.siteHostMap（host -> siteId）。
 * 查不到的请求（下载器、备份服务、社交 API 等）使用 "default" 作为诊断标签；Cookie 仍按 URL 匹配。
 *
 * 二进制支持：responseType 为 arraybuffer/blob 时，req.binary=true，Rust 以 base64 返回 body，
 * adapter 解码为 ArrayBuffer/Blob，保证种子文件等二进制内容不损坏。
 */
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { invoke } from "@tauri-apps/api/core";

import { extStorage } from "@/storage.ts";
import {
  buildRequestUrl,
  createAxiosResponse,
  headersToRecord,
  isBinaryResponseType,
  resolveSiteId,
  serializeRequestBody,
  toAxiosTransportError,
  type FetchResponse,
  withCancellation,
} from "./tauriAdapterCore.ts";

// host -> siteId 映射缓存。首次请求时从 extStorage.metadata 加载，metadata 变更后需 invalidate。
let hostMapCache: Record<string, string> | null = null;
let hostMapPromise: Promise<Record<string, string>> | null = null;

async function loadHostMap(): Promise<Record<string, string>> {
  if (hostMapCache) return hostMapCache;
  if (!hostMapPromise) {
    hostMapPromise = (async () => {
      const metadata = (await extStorage.getItem("metadata")) as { siteHostMap?: Record<string, string> } | null;
      hostMapCache = metadata?.siteHostMap ?? {};
      return hostMapCache;
    })();
  }
  return hostMapPromise;
}

/** metadata 变更后调用，使下次请求重新加载 host->siteId 映射。 */
export function invalidateHostMapCache() {
  hostMapCache = null;
  hostMapPromise = null;
}

export type HttpResourceKind = "site" | "service";

export interface HttpResourceIdentity {
  kind: HttpResourceKind;
  resourceId: string;
}

export function createTauriAdapter(identity?: HttpResourceIdentity): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const responseType = config.responseType;
    const binary = isBinaryResponseType(responseType);
    const fullUrl = buildRequestUrl(config);

    const hostMap = await loadHostMap();
    const inferredSiteId = resolveSiteId(fullUrl, hostMap);
    const resource = identity ?? {
      kind: inferredSiteId === "default" ? ("service" as const) : ("site" as const),
      resourceId: inferredSiteId === "default" ? `legacy:${new URL(fullUrl).host}` : inferredSiteId,
    };
    const serialized = await serializeRequestBody(config.data, headersToRecord(config.headers, config.auth));
    const requestId = crypto.randomUUID();

    const request = invoke<FetchResponse>("ptd_fetch", {
      req: {
        requestId,
        siteId: resource.resourceId,
        resourceEndpoint: new URL(fullUrl).origin,
        resourceKind: resource.kind,
        url: fullUrl,
        method: (config.method ?? "get").toLowerCase(),
        headers: serialized.headers,
        body: serialized.body,
        timeout: config.timeout,
        binary,
      },
    }).catch((error: unknown) => Promise.reject(toAxiosTransportError(error, config)));
    const resp = await withCancellation(request, config, () =>
      invoke<void>("ptd_cancel_fetch", { requestId }).catch(() => undefined),
    );

    return createAxiosResponse(resp, config);
  };
}

// 仅供尚未迁移的站点调用；调用方必须显式传入该 adapter，禁止修改 axios.defaults。
export const tauriAdapter = createTauriAdapter();

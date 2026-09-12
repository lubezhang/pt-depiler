/**
 * Tauri 迁移：Cloudflare 拦截重试已由 Rust ptd_fetch 统一处理（521/522/523/403 重试）。
 * 保留 isCloudflareBlocked 供 site schemas 做业务层判断。
 */
import type { AxiosResponse } from "axios";

const cloudflareBlocked5xxCodes = [
  521, // used by cloudflare to signal the original webserver is refusing the connection
  522, // used by cloudflare to signal the original webserver is not reachable at all (timeout)
  523, // used by cloudflare to signal the original webserver is not reachable at all (Origin is unreachable)
];

export function isCloudflareBlocked(response: AxiosResponse): boolean {
  if (!response) {
    return false;
  }

  try {
    // https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/#detect-a-challenge-page-response
    if (response.headers?.["cf-mitigated"] === "challenge") {
      return true;
    }

    if (cloudflareBlocked5xxCodes.includes(response.status)) {
      return true;
    }

    // 其他 403 需进一步判断
    if (response.status === 403) {
      const request = response.request as XMLHttpRequest | undefined;
      // adapter 模式下 response.request 为空对象，回退到 response.data（body string）
      let responseText: string | undefined;
      if (request?.responseType === "document") {
        responseText = request.responseXML?.documentElement?.outerHTML;
      } else if (typeof request?.responseText === "string") {
        responseText = request.responseText;
      } else if (typeof response.data === "string") {
        responseText = response.data;
      }

      if (typeof responseText === "undefined") {
        return false; // 检查最终的Text，如果什么都没有, bypass
      } else if (/Enable JavaScript and cookies to continue/.test(responseText)) {
        return true; // 包含关键字，说明被封锁
      }
    }
  } catch (e) {
    console.error("[CFBlockCheck] An error occurred while checking CF block status:", e);
  }

  return false;
}

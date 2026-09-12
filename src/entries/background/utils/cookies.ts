/**
 * Tauri 迁移：cookie 读写对接 Rust 命令（get_cookies/set_cookie）。
 *
 * Rust 侧使用单一全局 cookie_store（reqwest + cookie_store crate），cookie 按 domain 隔离，
 * ptd_fetch 请求自动携带 cookie，并自动写入 set-cookie。
 */
import { add, differenceInDays } from "date-fns";
import { invoke } from "@tauri-apps/api/core";

import { onMessage, sendMessage } from "@/messages.ts";
import { extStorage } from "@/storage.ts";
import { redactCookieUrl, toAppCookie, toCookieInfo, type CookieInfo } from "./cookieCore.ts";

/** 计算cookie的剩余有效期（以天为单位） */
export function calculateRemainingDays(expirationDate?: number): number {
  if (!expirationDate) {
    return Infinity;
  }
  const expirationDateMs = expirationDate * 1000;
  const remainingDays = differenceInDays(new Date(expirationDateMs), new Date());
  return Math.max(0, remainingDays);
}

onMessage("getAllCookies", async ({ data }) => {
  let domain: string | undefined;
  if (data?.domain) {
    domain = data.domain;
  } else if (data?.url) {
    try {
      domain = new URL(data.url).hostname;
    } catch {
      domain = undefined;
    }
  }
  const cookies = await invoke<CookieInfo[]>("get_cookies", { domain });
  return cookies.map(toAppCookie);
});

onMessage("setCookie", async ({ data }) => {
  await invoke("set_cookie", { cookie: toCookieInfo(data) });
});

/**
 * 检查并延长指定域名的 cookies（c_secure_* / remember_web_* 前缀，剩余时间低于阈值时延长）。
 */
export async function checkAndExtendCookies(url: string): Promise<void> {
  const logUrl = redactCookieUrl(url);
  try {
    const config = (await extStorage.getItem("config"))?.autoExtendCookies ?? { enabled: false };
    if (!config.enabled) {
      return;
    }

    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }

    const cookies = await invoke<CookieInfo[]>("get_cookies", { domain: host });
    const thresholdDays = config.triggerThreshold * 7;

    for (const cookie of cookies) {
      try {
        const remainingDays = calculateRemainingDays(cookie.expirationDate);
        if (remainingDays === Infinity) {
          continue;
        }
        const shouldExtend = cookie.name.startsWith("c_secure_") || cookie.name.startsWith("remember_web_");
        if (remainingDays < thresholdDays && shouldExtend) {
          const newExpirationDate = Math.floor(add(new Date(), { months: config.extensionDuration }).getTime() / 1000);
          await invoke("set_cookie", { cookie: { ...cookie, expirationDate: newExpirationDate } });
        }
      } catch (error) {
        sendMessage("logger", {
          msg: `Failed to extend cookie ${cookie.name} for url ${logUrl}`,
          level: "debug",
        }).catch();
      }
    }
  } catch (error) {
    sendMessage("logger", { msg: `Failed to check and extend cookies for url ${logUrl}`, level: "debug" }).catch();
  }
}

onMessage("checkAndExtendCookies", async ({ data: url }) => {
  await checkAndExtendCookies(url);
});

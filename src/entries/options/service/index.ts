/**
 * Tauri 迁移业务逻辑入口。
 *
 * 原扩展分 background（service worker）+ offscreen 两个上下文，通过 chrome.runtime 消息通信。
 * Tauri 单进程模型下，options 进程加载此模块即完成所有 onMessage handler 注册，
 * sendMessage（见 @/messages.ts 单进程本地路由）可直接调到。
 *
 * 不加载的浏览器特有模块：contextMenus / omnibox / webRequest / offscreen(setup) / nativeMessaging
 * - contextMenus / omnibox：浏览器右键菜单 / 地址栏，桌面端无对应
 * - webRequest / DNR：ptd_fetch 在 Rust 侧自由设头，不再需要
 * - offscreen setup：单进程无需跨上下文文档
 * - nativeMessaging：MVP 禁用（依赖 chrome.runtime.connectNative），handler 占位返回 disabled
 */
import { onMessage } from "@/messages.ts";
import type { BridgeStatus } from "@/shared/types.ts";

// 业务核心（原 offscreen 上下文注册的 47 个 handler：search/download/userInfo/backup/social/keepUpload/logger/site）
import "@/offscreen/offscreen.ts";

// 基础 handler：openOptionsPage / downloadFile / getExtStorage / setExtStorage
import "@/background/utils/base.ts";

// cookie handler（占位，待 Rust cookie 读写实现）
import "@/background/utils/cookies.ts";

// 定时任务：监听 Rust scheduler event + reDownloadTorrent
import "@/background/utils/alarms.ts";

// 启动时修复存储中的坏数据（原 chrome.runtime.onInstalled 行为）
import { fixAllStoredUserInfo } from "@/background/utils/fixer.ts";
fixAllStoredUserInfo().catch();

onMessage("ping", async ({ data }) => {
  return data ?? "pong";
});

// NativeBridge 占位（MVP 禁用）
const disabledBridge: BridgeStatus = {
  permissionGranted: false,
  enabled: false,
  state: "disabled",
  connected: false,
};
onMessage("nativeBridgeGetStatus", async () => disabledBridge);
onMessage("nativeBridgeSetEnabled", async () => disabledBridge);
onMessage("nativeBridgeReconnect", async () => disabledBridge);

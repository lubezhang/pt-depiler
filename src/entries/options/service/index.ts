/**
 * Tauri 迁移业务逻辑入口。
 *
 * Tauri 单进程模型下，options 进程加载此模块即完成所有业务 handler 注册，
 * sendMessage（见 @/messages.ts 单进程本地路由）可直接调到。
 */
// 业务核心：search/download/userInfo/backup/social/keepUpload/logger/site
import "@/offscreen/offscreen.ts";

// 基础 handler：downloadFile / getExtStorage / setExtStorage
import "@/background/utils/base.ts";

// Cookie handler
import "@/background/utils/cookies.ts";

// 定时任务：监听 Rust scheduler event + reDownloadTorrent
import "@/background/utils/alarms.ts";

// 启动时修复存储中的坏数据
import { fixAllStoredUserInfo } from "@/background/utils/fixer.ts";
fixAllStoredUserInfo().catch();

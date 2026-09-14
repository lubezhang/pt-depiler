export interface TemporaryException {
  reason: string;
  removalTask: string;
}

export const emptyCatchAllowances: Record<string, TemporaryException & { maximum: number }> = {
  "src/entries/options/views/Overview/MyData/UserDataTimeline/utils.ts": {
    maximum: 1,
    reason: "图表渲染的兼容性降级路径。",
    removalTask: "DT-026",
  },
  "src/packages/backupServer/entity/CookieCloud.ts": {
    maximum: 1,
    reason: "第三方 CookieCloud 响应兼容。",
    removalTask: "DT-026",
  },
  "src/packages/backupServer/entity/Gist.ts": {
    maximum: 1,
    reason: "远端 Gist 元数据兼容。",
    removalTask: "DT-026",
  },
  "src/packages/backupServer/entity/GoogleDrive.ts": {
    maximum: 1,
    reason: "Google Drive 旧接口兼容。",
    removalTask: "DT-026",
  },
  "src/packages/backupServer/entity/OWSS.ts": {
    maximum: 1,
    reason: "第三方 OWSS 响应兼容。",
    removalTask: "DT-026",
  },
  "src/packages/backupServer/entity/WebDAV.ts": {
    maximum: 1,
    reason: "WebDAV 目录探测兼容。",
    removalTask: "DT-026",
  },
  "src/packages/downloader/entity/Aria2.ts": {
    maximum: 2,
    reason: "Aria2 版本兼容与非关键清理路径。",
    removalTask: "DT-026",
  },
  "src/packages/downloader/entity/Deluge.ts": {
    maximum: 2,
    reason: "Deluge 可选能力探测。",
    removalTask: "DT-026",
  },
  "src/packages/downloader/entity/Flood.ts": {
    maximum: 1,
    reason: "Flood 可选状态兼容。",
    removalTask: "DT-026",
  },
  "src/packages/downloader/entity/Transmission.ts": {
    maximum: 3,
    reason: "Transmission 可选字段兼容。",
    removalTask: "DT-026",
  },
  "src/packages/site/definitions/retroflix.ts": {
    maximum: 1,
    reason: "站点页面解析容错。",
    removalTask: "DT-026",
  },
  "src/packages/site/schemas/Gazelle.ts": {
    maximum: 1,
    reason: "Gazelle 页面解析容错。",
    removalTask: "DT-026",
  },
  "src/packages/site/schemas/NexusPHP.ts": {
    maximum: 1,
    reason: "NexusPHP 页面解析容错。",
    removalTask: "DT-026",
  },
  "src/packages/site/utils/favicon.ts": {
    maximum: 4,
    reason: "站点图标解析容错。",
    removalTask: "DT-026",
  },
  "src/packages/site/utils/html.ts": {
    maximum: 1,
    reason: "页面 HTML 解析容错。",
    removalTask: "DT-026",
  },
  "src/packages/social/entity/imdb.ts": {
    maximum: 1,
    reason: "IMDb 解析容错。",
    removalTask: "DT-026",
  },
  "src/packages/social/index.ts": {
    maximum: 1,
    reason: "社交信息可选字段解析。",
    removalTask: "DT-026",
  },
};

export const packageEntryImportAllowances: Record<string, TemporaryException> = {
  "src/packages/backupServer/entity/CookieCloud.ts:@/shared/types.ts": {
    reason: "旧 Cookie DTO 共享类型。",
    removalTask: "DT-026",
  },
  "src/packages/backupServer/type.ts:@/shared/types.ts": {
    reason: "旧 Cookie DTO 共享类型。",
    removalTask: "DT-026",
  },
  "src/packages/site/utils/adapter.ts:@/messages.ts": {
    reason: "旧本地消息总线适配器。",
    removalTask: "DT-026",
  },
  "src/packages/site/utils/adapter.ts:@/shared/types/storages/metadata.ts": {
    reason: "旧 metadata DTO。",
    removalTask: "DT-026",
  },
  "src/packages/site/utils/adapter.ts:@/storage.ts": {
    reason: "旧扩展存储适配器。",
    removalTask: "DT-026",
  },
};

export const sideEffectImportAllowances: Record<string, TemporaryException> = {
  "src/entries/offscreen/offscreen.ts:./adapter/indexdb.ts": {
    reason: "旧 offscreen 存储适配器注册。",
    removalTask: "DT-026",
  },
  "src/entries/offscreen/offscreen.ts:./utils/backup.ts": {
    reason: "旧备份 handler 注册。",
    removalTask: "DT-026",
  },
  "src/entries/offscreen/offscreen.ts:./utils/download.ts": {
    reason: "旧下载 handler 注册。",
    removalTask: "DT-026",
  },
  "src/entries/offscreen/offscreen.ts:./utils/keepUploadTask.ts": {
    reason: "旧辅种 handler 注册。",
    removalTask: "DT-026",
  },
  "src/entries/offscreen/offscreen.ts:./utils/logger.ts": {
    reason: "旧日志 handler 注册。",
    removalTask: "DT-026",
  },
  "src/entries/offscreen/offscreen.ts:./utils/search.ts": {
    reason: "旧搜索 handler 注册。",
    removalTask: "DT-026",
  },
  "src/entries/offscreen/offscreen.ts:./utils/site.ts": {
    reason: "旧站点 handler 注册。",
    removalTask: "DT-026",
  },
  "src/entries/offscreen/offscreen.ts:./utils/socialInformation.ts": {
    reason: "旧社交信息 handler 注册。",
    removalTask: "DT-026",
  },
  "src/entries/offscreen/offscreen.ts:./utils/socialRecommendations.ts": {
    reason: "旧社交推荐 handler 注册。",
    removalTask: "DT-026",
  },
  "src/entries/offscreen/offscreen.ts:./utils/userInfo.ts": {
    reason: "旧用户信息 handler 注册。",
    removalTask: "DT-026",
  },
  "src/entries/options/main.ts:./service/index.ts": {
    reason: "当前应用启动注册入口。",
    removalTask: "DT-008",
  },
  "src/entries/options/service/index.ts:@/background/utils/alarms.ts": {
    reason: "旧任务调度 handler 注册。",
    removalTask: "DT-008",
  },
  "src/entries/options/service/index.ts:@/background/utils/base.ts": {
    reason: "旧基础 handler 注册。",
    removalTask: "DT-008",
  },
  "src/entries/options/service/index.ts:@/background/utils/cookies.ts": {
    reason: "旧 Cookie handler 注册。",
    removalTask: "DT-008",
  },
  "src/entries/options/service/index.ts:@/offscreen/offscreen.ts": {
    reason: "旧 offscreen handler 注册。",
    removalTask: "DT-008",
  },
};

export const globalPatchAllowances: Record<string, TemporaryException> = {
  "src/entries/options/main.ts:axios.defaults.adapter": {
    reason: "旧 HTTP 适配器全局注册。",
    removalTask: "DT-015",
  },
  "src/extends/axios/tauriWebDAVTransport.ts:getPatcher().patch": {
    reason: "旧 WebDAV fetch 补丁。",
    removalTask: "DT-015",
  },
};

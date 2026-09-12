import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { saveAs } from "file-saver";

import { onMessage } from "@/messages.ts";
import { extStorage } from "@/storage.ts";

/**
 * - blob:/data: URL 是前端创建的，Rust 无法访问，直接用 file-saver 保存；
 * - 远程 URL 用 @tauri-apps/plugin-dialog 选保存路径后，由 Rust download_to_local 写盘。
 */
onMessage("downloadFile", async ({ data: downloadOptions }) => {
  const { url, filename, headers } = downloadOptions;

  if (url.startsWith("blob:") || url.startsWith("data:")) {
    const res = await fetch(url);
    const blob = await res.blob();
    saveAs(blob, filename || "download");
    return;
  }

  const savePath = await save({ defaultPath: filename || "download" });
  if (!savePath) {
    return;
  }
  await invoke("download_to_local", {
    req: { url, savePath, headers, timeout: 60_000 },
  });
});

// @ts-ignore - extStorage.getItem 返回 T | null，ProtocolMap 期望 T
onMessage("getExtStorage", async ({ data: key }) => {
  return await extStorage.getItem(key);
});

onMessage("setExtStorage", async ({ data: { key, value } }) => {
  await extStorage.setItem(key, value);
});

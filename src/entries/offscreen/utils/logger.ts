/**
 * 关于 logger 方法记录
 * 跨模块调用使用 sendMessage("logger", {}).catch()，当前模块内可直接调用 logger({})。
 */
import { nanoid } from "nanoid";
import { useSessionStorage } from "@vueuse/core";

import { onMessage } from "@/messages.ts";
import type { ILoggerItem } from "@/shared/types.ts";

const MAX_LOGGER_LENGTH = 500;
export const loggerStorage = useSessionStorage<ILoggerItem[]>("logger", []);

function safeMessage(message: string): string {
  return message
    .trim()
    .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
      try { return new URL(value).origin; } catch { return "[url]"; }
    })
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/._=-]+/gi, "[authorization]")
    .replace(/\b(?:password|passkey|token|secret|cookie|authorization|authCode)\s*[:=]\s*[^\s,;]+/gi, "[credential]");
}

function summarizeData(value: unknown): { type: string; count: number } | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (value && typeof value === "object") return { type: "object", count: Object.keys(value).length };
  return { type: typeof value, count: 1 };
}

export function logger(data: ILoggerItem) {
  loggerStorage.value.push({
    id: data.id ?? nanoid(),
    time: data.time ?? Date.now(),
    level: data.level,
    module: data.module ? safeMessage(data.module) : undefined,
    msg: safeMessage(data.msg),
    data: summarizeData(data.data),
  });
  if (loggerStorage.value.length > MAX_LOGGER_LENGTH) {
    loggerStorage.value.shift();
  }
}

onMessage("logger", ({ data }) => logger(data));

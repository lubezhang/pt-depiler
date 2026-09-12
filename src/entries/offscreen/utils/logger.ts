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

export function logger(data: ILoggerItem) {
  data.id ??= nanoid();
  data.time ??= new Date().getTime();
  data.msg = data.msg?.trim();

  loggerStorage.value.push(data);
  if (loggerStorage.value.length > MAX_LOGGER_LENGTH) {
    loggerStorage.value.shift();
  }
}

onMessage("logger", ({ data }) => logger(data));

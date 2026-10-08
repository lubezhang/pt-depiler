import type { AppErrorCode } from "~/generated/ipc.ts";
export type ErrorCode = AppErrorCode;

export interface AppErrorDto {
  code: ErrorCode;
  message: string;
  operationId?: string;
  resourceId?: string;
  taskId?: string;
}

export interface LogRecord extends AppErrorDto {
  level: "debug" | "error" | "info" | "warn";
  timestamp: string;
}

const sensitiveKey = /authorization|cookie|password|secret|token/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redact(nested),
    ]),
  );
}

export function toAppError(error: unknown, fallback: ErrorCode = "INFRASTRUCTURE_FAILURE"): AppErrorDto {
  if (isAppError(error)) {
    const result: AppErrorDto = { code: error.code, message: errorMessages[error.code] };
    for (const key of ["operationId", "resourceId", "taskId"] as const) {
      const value = error[key];
      if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)) result[key] = value;
    }
    return result;
  }
  return { code: fallback, message: "操作失败" };
}

const errorMessages: Record<ErrorCode, string> = {
  APP_BOOTSTRAP_FAILED: "应用启动失败",
  COMMAND_HANDLER_MISSING: "操作暂不可用",
  COMMAND_SERIALIZATION_INVALID: "操作参数无效",
  INFRASTRUCTURE_FAILURE: "操作失败",
  VALIDATION_FAILED: "操作参数无效",
  STORAGE_CONFLICT: "配置已被修改，请重读后重试",
  STORAGE_RECOVERY_REQUIRED: "恢复尚未完成，请保留恢复资料并重启；冲突需人工处理",
  STORAGE_COMMIT_UNCERTAIN: "提交结果待核对，请重启后确认",
  STORAGE_UNAVAILABLE: "存储暂不可用",
  HTTP_POLICY_REJECTED: "请求被网络策略拒绝",
  HTTP_RESPONSE_TOO_LARGE: "响应超过大小限制",
  HTTP_REQUEST_CANCELLED: "请求已取消",
  HTTP_TIMEOUT: "请求超时",
  FILE_DOWNLOAD_FAILED: "文件下载失败",
  IPC_INVALID_INPUT: "操作参数无效",
};

function isAppError(error: unknown): error is AppErrorDto {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    Object.hasOwn(errorMessages, error.code),
  );
}

export function createLogRecord(error: unknown, context: Omit<LogRecord, "code" | "message" | "timestamp">): LogRecord {
  return { ...toAppError(error), ...context, timestamp: new Date().toISOString() };
}

export type ContractMap = { [K in string]: { input: unknown; output: unknown } };
type Handler<Input, Output> = (input: Input) => Output | Promise<Output>;

function isSerializable(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value == null || ["boolean", "number", "string", "undefined"].includes(typeof value)) return true;
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return false;
  if (typeof value !== "object") return false;
  if (value instanceof Date || value instanceof RegExp || (typeof Node !== "undefined" && value instanceof Node))
    return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).every((item) => isSerializable(item, seen));
}

export class TypedBus<T extends ContractMap> {
  private readonly handlers = new Map<keyof T, Handler<unknown, unknown>>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  constructor(private readonly names: readonly (keyof T)[]) {}

  register<K extends keyof T>(name: K, handler: Handler<T[K]["input"], T[K]["output"]>): void {
    if (this.handlers.has(name))
      throw { code: "VALIDATION_FAILED", message: `Command already registered: ${String(name)}` };
    this.handlers.set(name, handler as Handler<unknown, unknown>);
  }

  replace<K extends keyof T>(name: K, handler: Handler<T[K]["input"], T[K]["output"]>): void {
    this.handlers.set(name, handler as Handler<unknown, unknown>);
  }

  assertRegistered(): void {
    const missing = this.names.filter((name) => !this.handlers.has(name));
    if (missing.length > 0)
      throw {
        code: "COMMAND_HANDLER_MISSING",
        message: `Missing handlers for protocols: ${missing.join(", ")}`,
      };
  }

  async execute<K extends keyof T>(name: K, input: T[K]["input"]): Promise<T[K]["output"]> {
    if (!isSerializable(input))
      throw { code: "COMMAND_SERIALIZATION_INVALID", message: `Invalid command input: ${String(name)}` };
    const handler = this.handlers.get(name);
    if (!handler) throw { code: "COMMAND_HANDLER_MISSING", message: `No handler registered: ${String(name)}` };
    const output = await handler(input);
    if (!isSerializable(output))
      throw { code: "COMMAND_SERIALIZATION_INVALID", message: `Invalid command output: ${String(name)}` };
    return output as T[K]["output"];
  }

  on<Event extends string>(event: Event, listener: (payload: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  emit<Event extends string>(event: Event, payload: unknown): void {
    if (!isSerializable(payload))
      throw { code: "COMMAND_SERIALIZATION_INVALID", message: `Invalid event payload: ${event}` };
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }

  dispose(): void {
    this.handlers.clear();
    this.listeners.clear();
  }
}

export class CommandBus<T extends ContractMap> extends TypedBus<T> {}
export class QueryBus<T extends ContractMap> extends TypedBus<T> {}

export class EventBus<T extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof T, Set<(payload: unknown) => void>>();

  on<K extends keyof T>(event: K, listener: (payload: T[K]) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (payload: unknown) => void);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as (payload: unknown) => void);
  }

  emit<K extends keyof T>(event: K, payload: T[K]): void {
    if (!isSerializable(payload))
      throw { code: "COMMAND_SERIALIZATION_INVALID", message: `Invalid event payload: ${String(event)}` };
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }
}

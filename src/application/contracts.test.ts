import { describe, expect, it, vi } from "vitest";

import { CommandBus, EventBus, QueryBus, createLogRecord, redact, toAppError } from "./contracts.ts";

describe("应用错误与日志契约", () => {
  it("稳定错误码并脱敏敏感字段", () => {
    expect(toAppError(new Error("disk unavailable"))).toEqual({
      code: "INFRASTRUCTURE_FAILURE",
      message: "disk unavailable",
    });
    expect(redact({ password: "secret", nested: { token: "value", safe: "ok" } })).toEqual({
      password: "[REDACTED]",
      nested: { token: "[REDACTED]", safe: "ok" },
    });
    expect(createLogRecord(new Error("failed"), { level: "error", operationId: "bootstrap" })).toMatchObject({
      code: "INFRASTRUCTURE_FAILURE",
      operationId: "bootstrap",
    });
  });
});

describe("类型化总线", () => {
  type Commands = { add: { input: { left: number; right: number }; output: { total: number } } };

  it("验证注册与序列化边界，并支持事件取消订阅", async () => {
    const bus = new CommandBus<Commands>(["add"]);
    bus.register("add", ({ left, right }) => ({ total: left + right }));
    bus.assertRegistered();
    await expect(bus.execute("add", { left: 1, right: 2 })).resolves.toEqual({ total: 3 });
    await expect(bus.execute("add", { left: 1, right: 2, callback: () => {} } as never)).rejects.toMatchObject({
      code: "COMMAND_SERIALIZATION_INVALID",
    });
    const listener = vi.fn();
    const unsubscribe = bus.on("changed", listener);
    bus.emit("changed", { total: 3 });
    unsubscribe();
    bus.emit("changed", { total: 4 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("区分 Query 与 Event 协议", async () => {
    const queries = new QueryBus<{ get: { input: { id: string }; output: { id: string } } }>(["get"]);
    queries.register("get", ({ id }) => ({ id }));
    await expect(queries.execute("get", { id: "resource-1" })).resolves.toEqual({ id: "resource-1" });
    const events = new EventBus<{ changed: { resourceId: string } }>();
    const listener = vi.fn();
    events.on("changed", listener);
    events.emit("changed", { resourceId: "resource-1" });
    expect(listener).toHaveBeenCalledWith({ resourceId: "resource-1" });
  });
});

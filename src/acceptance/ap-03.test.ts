import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-konva", () => ({ default: {} }));
vi.mock("../entries/options/App.vue", () => ({ default: {} }));
vi.mock("../entries/options/plugins/i18n.ts", () => ({ i18nInstance: {} }));
vi.mock("../entries/options/plugins/pinia.ts", () => ({ piniaInstance: {} }));
vi.mock("../entries/options/plugins/router.ts", () => ({ routerInstance: {} }));
vi.mock("../entries/options/plugins/vuetify.ts", () => ({ vuetifyInstance: {} }));
vi.mock("../entries/options/service/index.ts", () => ({
  registerLegacyServices: async () => undefined,
  startLegacyRecovery: async () => undefined,
  startLegacyWorkers: async () => async () => undefined,
}));

import {
  bootstrapApp,
  disposeActiveApp,
  type AppContext,
  type BootstrapDependencies,
} from "../entries/options/bootstrap.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const contexts: AppContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.dispose()));
  document.body.replaceChildren();
});

function dependencies(overrides: Partial<BootstrapDependencies> = {}) {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  const base: Partial<BootstrapDependencies> = {
    target: () => document.body,
    configureTransport: () => undefined,
    registerServices: async () => undefined,
    repairStorage: async () => undefined,
    prepareCache: async () => undefined,
    startWorkers: async () => async () => undefined,
    createApp: () => ({ mount: mounted, unmount: unmounted }) as never,
    report: vi.fn(),
  };
  return { values: { ...base, ...overrides }, mounted, unmounted };
}

describe("AP-03 application lifecycle", () => {
  it("关闭入口等待重建完成并释放当前实例", async () => {
    const first = dependencies();
    contexts.push(await bootstrapApp(first.values));
    const gate = deferred();
    const stop = vi.fn(async () => undefined);
    const second = dependencies({ prepareCache: () => gate.promise, startWorkers: async () => stop });
    const rebuilding = bootstrapApp(second.values);
    const closing = disposeActiveApp();
    gate.resolve();
    contexts.push(await rebuilding);
    await closing;
    expect(first.unmounted).toHaveBeenCalledOnce();
    expect(second.unmounted).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("缓存准备前创建并配置应用，恢复完成前仍不挂载", async () => {
    const order: string[] = [];
    const setup = dependencies({
      createApp: () => {
        order.push("createApp");
        return {
          mount: () => order.push("mount"),
          unmount: () => order.push("unmount"),
        } as never;
      },
      prepareCache: async () => {
        order.push("prepareCache");
        expect(order).not.toContain("mount");
      },
    });
    const context = await bootstrapApp(setup.values);
    contexts.push(context);
    expect(order).toEqual(["createApp", "prepareCache", "mount"]);
  });

  it("等待恢复和缓存准备，释放等待正在运行的调度任务", async () => {
    const recovery = deferred();
    const cache = deferred();
    const runningTask = deferred();
    const stop = vi.fn(() => runningTask.promise);
    const setup = dependencies({
      repairStorage: () => recovery.promise,
      prepareCache: () => cache.promise,
      startWorkers: async () => stop,
    });
    const starting = bootstrapApp(setup.values);
    await Promise.resolve();
    expect(setup.mounted).not.toHaveBeenCalled();
    recovery.resolve();
    await vi.waitFor(() => expect(setup.mounted).not.toHaveBeenCalled());
    cache.resolve();
    const context = await starting;
    contexts.push(context);
    expect(setup.mounted).toHaveBeenCalledOnce();

    const first = context.dispose();
    const second = context.dispose();
    expect(first).toBe(second);
    expect(setup.unmounted).not.toHaveBeenCalled();
    runningTask.resolve();
    await Promise.all([first, second]);
    expect(stop).toHaveBeenCalledOnce();
    expect(setup.unmounted).toHaveBeenCalledOnce();
  });

  it("恢复失败后可重试，重建先等待旧监听器释放", async () => {
    const failed = dependencies({
      repairStorage: async () => {
        throw new Error("failed");
      },
    });
    await expect(bootstrapApp(failed.values)).rejects.toMatchObject({ code: "APP_BOOTSTRAP_FAILED" });
    expect(failed.mounted).not.toHaveBeenCalled();

    const stopGate = deferred();
    const first = dependencies({ startWorkers: async () => () => stopGate.promise });
    const old = await bootstrapApp(first.values);
    contexts.push(old);
    const next = dependencies();
    const rebuilding = bootstrapApp(next.values);
    await Promise.resolve();
    expect(next.mounted).not.toHaveBeenCalled();
    stopGate.resolve();
    const replacement = await rebuilding;
    contexts.push(replacement);
    expect(first.unmounted).toHaveBeenCalledOnce();
    expect(next.mounted).toHaveBeenCalledOnce();
  });
});

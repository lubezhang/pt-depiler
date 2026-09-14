import { describe, expect, it, vi } from "vitest";

vi.mock("vue-konva", () => ({ default: {} }));
vi.mock("./App.vue", () => ({ default: {} }));
vi.mock("./plugins/i18n.ts", () => ({ i18nInstance: {} }));
vi.mock("./plugins/pinia.ts", () => ({ piniaInstance: {} }));
vi.mock("./plugins/router.ts", () => ({ routerInstance: {} }));
vi.mock("./plugins/vuetify.ts", () => ({ vuetifyInstance: {} }));
vi.mock("./service/index.ts", () => ({
  registerLegacyServices: async () => undefined,
  startLegacyRecovery: () => undefined,
}));

import { bootstrapApp } from "./bootstrap.ts";

describe("bootstrapApp", () => {
  it("按顺序初始化并可释放 Vue 应用", async () => {
    const calls: string[] = [];
    const app = { mount: vi.fn(() => calls.push("mount")), unmount: vi.fn(() => calls.push("unmount")) };
    const context = await bootstrapApp({
      configureTransport: () => calls.push("transport"),
      registerServices: async () => {
        calls.push("services");
      },
      repairStorage: () => calls.push("repair"),
      createApp: () => app as never,
      target: () => document.body,
    });
    context.dispose();
    expect(calls).toEqual(["transport", "services", "repair", "mount", "unmount"]);
  });

  it("失败时不挂载业务应用并渲染诊断", async () => {
    const report = vi.fn();
    await expect(
      bootstrapApp({
        registerServices: async () => Promise.reject(new Error("registration failed")),
        target: () => document.body,
        report,
      }),
    ).rejects.toMatchObject({ code: "APP_BOOTSTRAP_FAILED" });
    expect(document.body.textContent).toContain("registration failed");
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: "APP_BOOTSTRAP_FAILED" }));
  });
});

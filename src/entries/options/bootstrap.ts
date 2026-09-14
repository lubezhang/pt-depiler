import { createApp, type App as VueApp } from "vue";
import VueKonva from "vue-konva";

import { createLogRecord, toAppError, type AppErrorDto } from "~/application/contracts.ts";
import App from "./App.vue";
import { i18nInstance as i18n } from "./plugins/i18n.ts";
import { piniaInstance as pinia } from "./plugins/pinia.ts";
import { routerInstance as router } from "./plugins/router.ts";
import { vuetifyInstance as vuetify } from "./plugins/vuetify.ts";
import { registerLegacyServices } from "./service/index.ts";
import { startLegacyRecovery } from "./service/index.ts";

export interface AppContext {
  app: VueApp;
  dispose(): void;
}

export interface BootstrapDependencies {
  configureTransport(): void;
  createApp(): VueApp;
  registerServices(): Promise<void>;
  repairStorage(): void;
  target(): Element | null;
  report(error: AppErrorDto): void;
}

function failureView(target: Element, error: AppErrorDto): void {
  target.replaceChildren();
  const heading = document.createElement("h1");
  heading.textContent = "应用启动失败";
  const detail = document.createElement("p");
  detail.textContent = `${error.code}: ${error.message}`;
  target.append(heading, detail);
}

function defaultDependencies(): BootstrapDependencies {
  return {
    configureTransport: () => undefined,
    createApp: () => createApp(App).use(pinia).use(i18n).use(router).use(vuetify).use(VueKonva, { prefix: "Vk" }),
    registerServices: registerLegacyServices,
    repairStorage: startLegacyRecovery,
    target: () => document.querySelector("#app"),
    report: (error) =>
      console.error("[bootstrap]", createLogRecord(error, { level: "error", operationId: "bootstrap" })),
  };
}

export async function bootstrapApp(overrides: Partial<BootstrapDependencies> = {}): Promise<AppContext> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const target = dependencies.target();
  if (!target) throw { code: "APP_BOOTSTRAP_FAILED", message: "Missing #app mount target" } satisfies AppErrorDto;
  try {
    dependencies.configureTransport();
    await dependencies.registerServices();
    dependencies.repairStorage();
    const app = dependencies.createApp();
    app.mount(target);
    return { app, dispose: () => app.unmount() };
  } catch (error) {
    const appError = toAppError(error, "APP_BOOTSTRAP_FAILED");
    dependencies.report(appError);
    failureView(target, appError);
    throw appError;
  }
}

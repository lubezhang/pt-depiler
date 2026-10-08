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
import { startLegacyWorkers } from "./service/index.ts";
import { useConfigStore } from "./stores/config.ts";
import { useMetadataStore } from "./stores/metadata.ts";
import { refreshResourceCache, startResourceCacheSync } from "./service/cacheSync.ts";

export interface AppContext {
  app: VueApp;
  dispose(): Promise<void>;
}

export interface BootstrapDependencies {
  configureTransport(): void;
  createApp(): VueApp;
  registerServices(): Promise<void>;
  repairStorage(): Promise<void>;
  prepareCache(): Promise<void>;
  startWorkers(): Promise<() => Promise<void>>;
  target(): Element | null;
  report(error: AppErrorDto): void;
}

function failureView(target: Element, error: AppErrorDto): void {
  target.replaceChildren();
  const heading = document.createElement("h1");
  heading.textContent = "应用启动失败";
  const detail = document.createElement("p");
  detail.textContent = `${error.code}: ${error.message} (${error.operationId ?? "bootstrap"})`;
  target.append(heading, detail);
}

function defaultDependencies(): BootstrapDependencies {
  return {
    configureTransport: () => undefined,
    createApp: () => createApp(App).use(pinia).use(i18n).use(router).use(vuetify).use(VueKonva, { prefix: "Vk" }),
    registerServices: registerLegacyServices,
    repairStorage: startLegacyRecovery,
    prepareCache: async () => {
      const config = useConfigStore(pinia);
      const metadata = useMetadataStore(pinia);
      await config.$onReady().catch(() => {
        throw { code: "APP_BOOTSTRAP_FAILED", message: "配置恢复失败", operationId: "bootstrap:configRestore" };
      });
      await metadata.$onReady().catch(() => {
        throw { code: "APP_BOOTSTRAP_FAILED", message: "资源配置恢复失败", operationId: "bootstrap:metadataRestore" };
      });
      await refreshResourceCache(pinia, true).catch(() => {
        throw { code: "APP_BOOTSTRAP_FAILED", message: "资源缓存读取失败", operationId: "bootstrap:cacheRead" };
      });
    },
    startWorkers: async () => {
      const stopWorkers = await startLegacyWorkers();
      const stopCache = startResourceCacheSync(pinia);
      return async () => {
        stopCache();
        await stopWorkers();
      };
    },
    target: () => document.querySelector("#app"),
    report: (error) =>
      console.error(
        "[bootstrap]",
        createLogRecord(error, { level: "error", operationId: error.operationId ?? "bootstrap" }),
      ),
  };
}

let activeContext: AppContext | undefined;
let transition: Promise<unknown> = Promise.resolve();

async function startApp(overrides: Partial<BootstrapDependencies>): Promise<AppContext> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const target = dependencies.target();
  if (!target) throw { code: "APP_BOOTSTRAP_FAILED", message: "Missing #app mount target" } satisfies AppErrorDto;
  let stopWorkers: (() => Promise<void>) | undefined;
  let app: VueApp | undefined;
  let phase = "dispose";
  try {
    await activeContext?.dispose();
    activeContext = undefined;
    phase = "configureTransport";
    dependencies.configureTransport();
    phase = "registerServices";
    await dependencies.registerServices();
    phase = "repairStorage";
    await dependencies.repairStorage();
    phase = "createApp";
    app = dependencies.createApp();
    phase = "prepareCache";
    await dependencies.prepareCache();
    phase = "startWorkers";
    stopWorkers = await dependencies.startWorkers();
    phase = "mount";
    app.mount(target);
    let stopping: Promise<void> | undefined;
    const context: AppContext = {
      app,
      dispose: () => {
        stopping ??= (async () => {
          await stopWorkers?.();
          app?.unmount();
          if (activeContext === context) activeContext = undefined;
        })().catch((error) => {
          stopping = undefined;
          throw error;
        });
        return stopping;
      },
    };
    activeContext = context;
    return context;
  } catch (error) {
    try {
      await stopWorkers?.();
      app?.unmount();
    } catch {
      console.error("[bootstrap] Failed to release failed startup");
    }
    const original = toAppError(error, "APP_BOOTSTRAP_FAILED");
    const appError = { ...original, operationId: original.operationId ?? `bootstrap:${phase}` };
    dependencies.report(appError);
    failureView(target, appError);
    throw appError;
  }
}

export function bootstrapApp(overrides: Partial<BootstrapDependencies> = {}): Promise<AppContext> {
  const next = transition.then(() => startApp(overrides));
  transition = next.catch(() => undefined);
  return next;
}

export function disposeActiveApp(): Promise<void> {
  const next = transition.then(async () => {
    await activeContext?.dispose();
  });
  transition = next.catch(() => undefined);
  return next;
}

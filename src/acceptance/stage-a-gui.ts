import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { extStorage } from "@/storage.ts";
import { bootstrapApp, disposeActiveApp } from "@/options/bootstrap.ts";
import type { IConfigPiniaStorageSchema } from "@/shared/types.ts";

type Request = { id: number; base: IConfigPiniaStorageSchema; value: IConfigPiniaStorageSchema };
type Response = { id: number; code?: string };

export async function runStageAPeer(): Promise<void> {
  await listen("stage-a:finish", async () => {
    await getCurrentWindow().close();
  });
  await listen<Request>("stage-a:request", async ({ payload }) => {
    let code: string | undefined;
    try {
      await extStorage.mergeItem("config", payload.base, payload.value);
    } catch (error) {
      code = (error as { code?: string }).code ?? "UNKNOWN";
    }
    await emitTo("main", "stage-a:response", { id: payload.id, code });
  });
  await emitTo("main", "stage-a:ready", {});
}

export async function runStageAMain(): Promise<void> {
  const results: string[] = [];
  const require = (condition: boolean, name: string) => {
    if (!condition) throw new Error(name);
    results.push(name);
  };
  let removeResponse: (() => void) | undefined;
  let removeReady: (() => void) | undefined;
  try {
    require(Boolean(document.querySelector("#app")?.children.length), "initial-mount");
    const ready = new Promise<void>((resolve) => {
      void listen("stage-a:ready", () => resolve()).then((remove) => {
        removeReady = remove;
        void emit("stage-a:create-peer");
      });
    });
    await ready;
    const pending = new Map<number, (response: Response) => void>();
    removeResponse = await listen<Response>("stage-a:response", ({ payload }) => pending.get(payload.id)?.(payload));
    let id = 0;
    const peerCommit = (base: IConfigPiniaStorageSchema, value: IConfigPiniaStorageSchema) =>
      new Promise<Response>((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, resolve);
        void emitTo("stage-a-peer", "stage-a:request", { id: requestId, base, value }).catch(reject);
      });
    const original = (await extStorage.getItem("config"))!;
    const base = await extStorage.mergeItem("config", original, { ...original, theme: "light", lang: "zh_CN" });
    await extStorage.mergeItem("config", base, { ...base, theme: "dark" });
    const independent = await peerCommit(base, { ...base, lang: "en" });
    const merged = (await extStorage.getItem("config"))!;
    require(!independent.code &&
      merged.theme === "dark" &&
      merged.lang === "en", "two-webviews-preserve-distinct-fields");
    const conflict = await peerCommit(base, { ...base, theme: "auto" });
    require(conflict.code === "STORAGE_CONFLICT" &&
      (await extStorage.getItem("config"))?.theme === "dark", "two-webviews-reject-same-field-conflict");
    await extStorage.mergeItem("config", merged, original);
    await disposeActiveApp();
    require(!document.querySelector("#app")?.children.length, "dispose-unmounts-current-app");
    await bootstrapApp();
    require(Boolean(document.querySelector("#app")?.children.length), "rebuild-mounts-after-recovery");
    await emitTo("stage-a-peer", "stage-a:finish", {});
    await emit("stage-a:result", { platform: "macOS", passed: true, results });
    await getCurrentWindow().close();
  } catch {
    await emit("stage-a:result", { platform: "macOS", passed: false, results });
  } finally {
    removeResponse?.();
    removeReady?.();
  }
}

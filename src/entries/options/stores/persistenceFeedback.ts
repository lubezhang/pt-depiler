import { isStorageConflict } from "~/extends/pinia/webExtPersistence.ts";
import { i18nInstance } from "@/options/plugins/i18n.ts";
import { useRuntimeStore } from "./runtime.ts";

export function reportPersistenceFailure(error: unknown): void {
  useRuntimeStore().showSnakebar(
    i18nInstance.global.t(isStorageConflict(error) ? "common.saveConflict" : "common.saveFailure"),
    { color: "error" },
  );
}

export async function commitSettings(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch {
    return false;
  }
}

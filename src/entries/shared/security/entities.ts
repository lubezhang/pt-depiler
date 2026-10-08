const fields = [
  "id",
  "type",
  "name",
  "enabled",
  "sortIndex",
  "url",
  "address",
  "groups",
  "isOffline",
  "allowSearch",
  "allowQueryUserInfo",
  "excludedSites",
  "suggestFolders",
  "suggestTags",
  "backupFields",
  "backupInterval",
  "lastBackupAt",
  "timeout",
];

export function entitySummary<T extends object>(source: T): T {
  const record = source as Record<string, unknown>;
  const summary = Object.fromEntries(
    fields.filter((key) => record[key] !== undefined).map((key) => [key, cloneDeep(record[key])]),
  );
  for (const key of ["url", "address"]) {
    if (typeof summary[key] === "string") {
      try {
        summary[key] = new URL(summary[key]).origin;
      } catch {
        delete summary[key];
      }
    }
  }
  const feature = record.feature as Record<string, unknown> | undefined;
  if (typeof feature?.DefaultAutoStart === "boolean") summary.feature = { DefaultAutoStart: feature.DefaultAutoStart };
  return summary as T;
}
import { cloneDeep } from "es-toolkit";

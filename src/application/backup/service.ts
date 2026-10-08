import { toMerged } from "es-toolkit";
import type { IBackupData } from "~/packages/backupServer/type.ts";
import { redactBackup, withoutBackupKey } from "./redaction.ts";

export type BackupField =
  "config" | "metadata" | "userInfo" | "downloadHistory" | "searchResultSnapshot" | "keepUploadTask" | "cookies";
export interface BackupSnapshot {
  revision: number;
  data: Omit<IBackupData, "cookies"> & { cookies?: unknown[] };
}
export interface BackupExportOptions {
  includeCredentials?: boolean;
}
export interface BackupRestoreOptions {
  includeCredentials?: boolean;
  fields?: BackupField[];
  expandCookieMinutes?: number;
  keepExistUserInfo?: boolean;
}
export interface BackupDependencies {
  snapshot(includeCookies: boolean): Promise<BackupSnapshot>;
  commit(revision: number, data: IBackupData, cookies?: unknown[]): Promise<string>;
  sanitize(field: BackupField, value: any): any;
  now(): number;
  version: string;
}

export class BackupService {
  constructor(private readonly ports: BackupDependencies) {}

  async prepareExport(
    fields: BackupField[],
    options: BackupExportOptions = {},
  ): Promise<{ data: IBackupData; encryptionKey: string }> {
    const snapshot = await this.ports.snapshot(fields.includes("cookies"));
    const encryptionKey = snapshot.data.config?.backup?.encryptionKey ?? "";
    if (!encryptionKey && (options.includeCredentials || fields.includes("cookies")))
      throw new Error("BACKUP_ENCRYPTION_REQUIRED");
    let data: IBackupData = {};
    for (const field of fields) {
      const value = snapshot.data[field];
      if (value !== undefined && value !== null) {
        data[field] = field === "cookies" ? { all: value } : this.ports.sanitize(field, value);
      }
    }
    data.manifest = {
      time: this.ports.now(),
      version: this.ports.version,
      redactedSecrets: !options.includeCredentials,
    };
    data = options.includeCredentials ? withoutBackupKey(data) : redactBackup(data);
    if (fields.includes("cookies")) {
      const verification = await this.ports.snapshot(true);
      if (JSON.stringify(verification.data.cookies) !== JSON.stringify(snapshot.data.cookies))
        throw new Error("BACKUP_COOKIE_SNAPSHOT_CHANGED");
    }
    return { data, encryptionKey };
  }

  async restore(input: IBackupData, options: BackupRestoreOptions = {}): Promise<boolean> {
    const fields = options.fields ?? [];
    if (!fields.length) return true;
    const available = input.manifest?.files ?? {};
    if (fields.some((field) => !Object.hasOwn(available, field) || !Object.hasOwn(input, field)))
      throw new Error("BACKUP_MISSING_DOMAIN");
    // The snapshot serves as the expected revision for every selected domain.
    const snapshot = await this.ports.snapshot(false);
    const redacted = input.manifest?.redactedSecrets || options.includeCredentials !== true;
    const values: IBackupData = {};
    let cookies: unknown[] | undefined;
    for (const field of fields) {
      const source = structuredClone(input[field]);
      const value =
        redacted && ["config", "metadata", "userInfo"].includes(field)
          ? redactBackup({ [field]: source })[field]
          : source;
      if (field === "cookies") {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.values(value).some((items) => !Array.isArray(items))
        )
          throw new Error("BACKUP_INVALID_COOKIES");
        cookies = (Object.values(value) as any[][]).flat();
        if ((options.expandCookieMinutes ?? 0) > 0) {
          for (const cookie of cookies as any[])
            cookie.expirationDate =
              Math.max(cookie.expirationDate ?? 0, this.ports.now() / 1000) + options.expandCookieMinutes! * 60;
        }
      } else {
        if (
          field === "downloadHistory"
            ? !Array.isArray(value)
            : !value || typeof value !== "object" || Array.isArray(value)
        )
          throw new Error("BACKUP_INVALID_DOMAIN");
        let proposed = this.ports.sanitize(field, value);
        if (
          (field === "userInfo" && (options.keepExistUserInfo !== false || redacted)) ||
          (redacted && ["config", "metadata"].includes(field))
        ) {
          proposed =
            field === "userInfo"
              ? toMerged(proposed, snapshot.data[field] ?? {})
              : toMerged(snapshot.data[field] ?? {}, proposed);
        }
        if (field === "metadata" && redacted) {
          for (const collection of ["sites", "downloaders", "backupServers", "mediaServers"]) {
            for (const [id, entity] of Object.entries(value[collection] ?? {}) as Array<[string, any]>) {
              const previous = snapshot.data.metadata?.[collection]?.[id];
              if (!previous || previous.type !== entity.type) {
                proposed[collection][id] = { ...entity, needsConfiguration: true };
              }
            }
          }
        }
        // Backup keys never participate in restore, including legacy imports.
        if (field === "config") {
          proposed.backup ??= {};
          proposed.backup.encryptionKey = snapshot.data.config?.backup?.encryptionKey ?? "";
        }
        values[field] = proposed;
      }
    }
    await this.ports.commit(snapshot.revision, values, cookies);
    return true;
  }
}

import type { IBackupData } from "@ptd/backupServer";

const identifier = /^[A-Za-z0-9_.:-]{1,128}$/;
const safeStatus = new Set(["success", "unknownError", "needLogin", "parseError", "networkError"]);
const userNumbers = new Set([
  "updateAt",
  "joinTime",
  "lastAccessAt",
  "totalTraffic",
  "downloaded",
  "trueDownloaded",
  "uploaded",
  "trueUploaded",
  "ratio",
  "trueRatio",
  "seeding",
  "seedingSize",
  "seedingTime",
  "averageSeedingTime",
  "bonus",
  "seedingBonus",
  "bonusPerHour",
  "seedingBonusPerHour",
  "uploads",
  "leeching",
  "snatches",
  "posts",
  "adoptions",
  "hnrUnsatisfied",
  "hnrPreWarning",
  "messageCount",
  "invites",
  "levelId",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function publicUserInfo(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (userNumbers.has(key) && typeof item === "number" && Number.isFinite(item)) result[key] = item;
    if (key === "status" && typeof item === "string" && safeStatus.has(item)) result[key] = item;
    if (key === "site" && typeof item === "string" && identifier.test(item)) result[key] = item;
  }
  return result;
}

export function cachedUserInfo(value: unknown): Record<string, unknown> {
  const source = record(value);
  const result = publicUserInfo(source);
  for (const key of ["name", "levelName"]) {
    if (typeof source[key] === "string") result[key] = source[key].slice(0, 128);
  }
  if (typeof source.id === "number" || (typeof source.id === "string" && identifier.test(source.id)))
    result.id = source.id;
  if (typeof source.isDonor === "boolean") result.isDonor = source.isDonor;
  return result;
}

export function publicUserHistory(value: unknown, project = publicUserInfo): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record(value))
      .filter(([site]) => identifier.test(site))
      .map(([site, days]) => [
        site,
        Object.fromEntries(
          Object.entries(record(days))
            .filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day))
            .map(([day, info]) => [day, project(info)]),
        ),
      ]),
  );
}

function publicConfig(value: unknown): Record<string, unknown> {
  const source = record(value);
  const result: Record<string, unknown> = {};
  for (const key of [
    "isNavBarOpen",
    "ignoreWrongPixelRatio",
    "showReleaseNoteOnVersionChange",
    "saveTableBehavior",
    "enableTableMultiSort",
  ]) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  if (source.lang === "zh_CN" || source.lang === "en") result.lang = source.lang;
  if (["auto", "light", "dark"].includes(String(source.theme))) result.theme = source.theme;
  if (typeof source.version === "string" && /^v?[0-9.+-]{1,48}$/.test(source.version)) result.version = source.version;
  if (typeof record(source.backup).enabledAutoBackup === "boolean") {
    result.backup = { enabledAutoBackup: record(source.backup).enabledAutoBackup };
  }
  return result;
}

function publicEntities(value: unknown, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record(value))
      .filter(([id]) => identifier.test(id))
      .map(([id, rawEntity]) => {
        const entity = record(rawEntity);
        const safe: Record<string, unknown> = { id };
        for (const field of fields) {
          const value = entity[field];
          if (field === "url" || field === "address" || field === "endpoint") {
            const origin = safeOrigin(value);
            if (origin) safe[field] = origin;
          } else if (field === "type" && typeof value === "string" && identifier.test(value)) {
            safe.type = value;
          } else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
            safe[field] = value;
          }
        }
        return [id, safe];
      }),
  );
}

function publicMetadata(value: unknown): Record<string, unknown> {
  const source = record(value);
  const sites = publicEntities(source.sites, ["url", "isOffline", "allowQueryUserInfo", "sortIndex"]);
  const siteHostMap = Object.fromEntries(
    Object.entries(record(source.siteHostMap)).filter(
      ([host, id]) => typeof id === "string" && id in sites && safeOrigin(`https://${host}`) === `https://${host}`,
    ),
  );
  return {
    sites,
    siteHostMap,
    downloaders: publicEntities(source.downloaders, ["type", "enabled", "address", "sortIndex"]),
    mediaServers: publicEntities(source.mediaServers, ["type", "enabled", "address"]),
    backupServers: publicEntities(source.backupServers, ["type", "enabled", "backupInterval", "lastBackupAt"]),
    solutions: {},
    snapshots: {},
    lastUserInfo: Object.fromEntries(
      Object.entries(record(source.lastUserInfo))
        .filter(([id]) => identifier.test(id))
        .map(([id, info]) => [id, publicUserInfo(info)]),
    ),
  };
}

export function redactBackup(data: IBackupData): IBackupData {
  return {
    ...data,
    ...(data.config && { config: publicConfig(data.config) as IBackupData["config"] }),
    ...(data.metadata && { metadata: publicMetadata(data.metadata) as IBackupData["metadata"] }),
    ...(data.userInfo && { userInfo: publicUserHistory(data.userInfo) as IBackupData["userInfo"] }),
  };
}

export function withoutBackupKey(data: IBackupData): IBackupData {
  if (!data.config) return data;
  const config = structuredClone(data.config);
  if (config.backup) config.backup.encryptionKey = "";
  return { ...data, config };
}

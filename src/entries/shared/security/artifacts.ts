import type { ITorrent } from "@ptd/site";
import type { CAddTorrentOptions } from "@ptd/downloader";
import type { IKeepUploadTask, ISearchData, ITorrentDownloadMetadata } from "@/shared/types.ts";

const torrentFields = [
  "site",
  "id",
  "title",
  "subTitle",
  "size",
  "time",
  "seeders",
  "leechers",
  "completed",
  "comments",
  "category",
  "progress",
  "status",
] as const;
const optionFields = [
  "localDownload",
  "addAtPaused",
  "savePath",
  "label",
  "uploadSpeedLimit",
  "downloadSpeedLimit",
] as const;

export function publicDetailUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value, "https://relative.invalid");
    if (!/^https?:$/.test(url.protocol)) return undefined;
    if (!/^\/(?:details?\.php|torrents?\.php|details?|torrents?|torrent\/detail)(?:\/\d+)*\/?$/i.test(url.pathname))
      return undefined;
    const query = new URLSearchParams();
    for (const key of ["id", "torrentid", "tid", "groupid"]) {
      const item = url.searchParams.get(key);
      if (item && /^\d+$/.test(item)) query.set(key, item);
    }
    if (!query.size && !/\/\d+\/?$/.test(url.pathname)) return undefined;
    const suffix = url.pathname + (query.size ? `?${query}` : "");
    return url.hostname === "relative.invalid" ? suffix : url.origin + suffix;
  } catch {
    return undefined;
  }
}

function pick(source: object, fields: readonly string[]): Record<string, unknown> {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(fields.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

export function publicDownloadOptions(source: Partial<CAddTorrentOptions>): Omit<CAddTorrentOptions, "localDownloadOption"> {
  return { savePath: "", addAtPaused: false, ...pick(source, optionFields) };
}

export function publicTorrent(source: Partial<ITorrent>): ITorrent {
  const torrent = pick(source, torrentFields) as unknown as ITorrent;
  torrent.id ??=
    [source.url, source.link]
      .map((url) => {
        if (!url) return undefined;
        try {
          const parsed = new URL(url, "https://relative.invalid");
          return (
            ["id", "torrentid", "tid"]
              .map((key) => parsed.searchParams.get(key))
              .find((id) => id && /^\d+$/.test(id)) ?? parsed.pathname.match(/\/(\d+)\/?$/)?.[1]
          );
        } catch {
          return undefined;
        }
      })
      .find(Boolean) ?? "unknown";
  torrent.url = publicDetailUrl(source.url);
  const magnet = source.link?.match(/^magnet:\?xt=(urn:btih:[A-Za-z0-9]{32,40})(?:&|$)/i);
  torrent.link = magnet ? `magnet:?xt=${magnet[1]}` : undefined;
  torrent.requiresFreshLink = !magnet;
  return torrent;
}

export function publicDownloadHistory(source: ITorrentDownloadMetadata): ITorrentDownloadMetadata {
  const torrent = publicTorrent(
    source.torrent ?? { site: source.siteId, id: source.torrentId, title: source.title, url: source.url },
  );
  return {
    ...pick(source, ["id", "siteId", "torrentId", "downloaderId", "title", "subTitle", "downloadAt", "downloadStatus"]),
    torrent,
    url: torrent.url,
    link: torrent.link,
    addTorrentOptions: pick(source.addTorrentOptions ?? {}, optionFields),
    ...(source.errorMessage && { errorMessage: "下载失败，请重新获取种子后重试" }),
  } as ITorrentDownloadMetadata;
}

export function publicKeepUploadTask(source: IKeepUploadTask): IKeepUploadTask {
  return {
    id: source.id,
    time: source.time,
    title: source.title,
    size: source.size,
    downloadOptions: {
      downloaderId: source.downloadOptions.downloaderId,
      ...pick(source.downloadOptions, ["downloaderId", "savePath", "clientName"]),
      addTorrentOptions: pick(source.downloadOptions.addTorrentOptions ?? {}, optionFields),
    },
    items: source.items.map((item) => {
      const torrent = publicTorrent({ ...item, url: item.link, link: item.url });
      return {
        ...pick(torrent, torrentFields),
        site: item.site,
        title: item.title,
        size: item.size,
        link: torrent.url ?? "",
        url: torrent.link ?? "",
        requiresFreshLink: torrent.requiresFreshLink,
      };
    }),
  } as IKeepUploadTask;
}

export function publicSearchSnapshot(source: ISearchData): ISearchData {
  return {
    ...pick(source, ["snapshot", "startAt", "endAt", "searchKey", "searchPlanKey"]),
    isSearching: false,
    searchPlan: {},
    searchResult: source.searchResult.map((torrent) => ({
      ...publicTorrent(torrent),
      ...pick(torrent, ["uniqueId", "solutionId", "solutionKey"]),
    })),
  } as ISearchData;
}

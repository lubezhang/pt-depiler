import type { ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "torrentscsv",
  name: "Torrents-CSV",
  aka: ["TorrentsCSV"],
  description: "Torrents.csv is a self-hostable, open source torrent search engine and database",

  type: "public",
  urls: ["https://torrents-csv.com/"],
  legacyUrls: ["https://torrents-csv.ml/"],

  search: {
    keywordPath: "params.q",
    requestConfig: {
      url: "/service/search",
      responseType: "json",
      params: { size: 100 },
    },
    skipWhiteSpacePlaceholder: true,
    selectors: {
      rows: { selector: "torrents" },
      id: { selector: "id" },
      title: { selector: "name" },
      url: { text: "https://torrents-csv.com/" }, // 该站种子不存在独立介绍页
      link: {
        selector: "infohash",
        filters: [(q: string) => `magnet:?xt=urn:btih:${q}`],
      },
      time: { selector: "created_unix" },
      size: { selector: "size_bytes" },
      seeders: { selector: "seeders" },
      leechers: { selector: "leechers" },
      completed: { selector: "completed" },
    },
  },
};

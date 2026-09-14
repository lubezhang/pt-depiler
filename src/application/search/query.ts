import { uniqBy } from "es-toolkit";
import { normalizedTorrentTagMap, sortTorrentTags, type IAdvancedSearchRequestConfig, type ISearchResult, type TPatterns, type TSiteID } from "@ptd/site";

import type { HttpClient, Logger, SettingsReader } from "~/domain/ports/index.ts";

export interface SearchSite {
  metadata: { officialGroupPattern?: TPatterns };
  getSearchResult(keyword: string, searchEntry: IAdvancedSearchRequestConfig): Promise<ISearchResult>;
}

export interface SearchSiteFactory {
  create(
    siteId: TSiteID,
    context: { http: HttpClient; settings: SettingsReader; logger: Logger },
  ): Promise<SearchSite>;
}

export interface SearchSettings {
  searchEntity?: { autoDetectOfficialGroupFromTitle?: boolean };
}

export interface SearchQueryInput {
  keyword?: string;
  searchEntry?: IAdvancedSearchRequestConfig;
  siteId: TSiteID;
}

export class SearchQuery {
  constructor(
    private readonly dependencies: {
      http: HttpClient;
      logger: Logger;
      settings: SettingsReader;
      siteFactory: SearchSiteFactory;
    },
  ) {}

  async execute({ siteId, keyword = "", searchEntry = {} }: SearchQueryInput): Promise<ISearchResult> {
    const { http, logger, settings, siteFactory } = this.dependencies;
    const config = await settings.get<SearchSettings>("config");
    logger.info("getSiteSearchResult", { keyword, resourceId: `site:${siteId}`, siteId });
    const site = await siteFactory.create(siteId, { http, logger, settings });
    const searchResult = await site.getSearchResult(keyword, searchEntry);

    if (searchResult.data.length === 0) return searchResult;

    const patterns = config?.searchEntity?.autoDetectOfficialGroupFromTitle
      ? site.metadata.officialGroupPattern
      : undefined;
    searchResult.data = searchResult.data.map((item) => {
      item.tags ??= [];
      if (patterns?.length && item.title && patterns.some((pattern) => new RegExp(pattern!, "i").test(item.title))) {
        item.tags.push({ name: "官方" });
      }
      item.tags = sortTorrentTags(
        uniqBy(
          item.tags.map((tag) => normalizedTorrentTagMap.find((candidate) => candidate.from.test(tag.name))?.to ?? tag),
          (tag) => tag.name,
        ),
      );
      return item;
    });
    return searchResult;
  }
}

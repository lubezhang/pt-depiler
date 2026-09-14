import { describe, expect, it, vi } from "vitest";
import { EResultParseStatus, type ISearchResult } from "@ptd/site";

import { InMemoryHttpClient, InMemoryLogger, type SettingsReader } from "~/domain/ports/index.ts";
import { SearchQuery } from "./query.ts";

describe("SearchQuery", () => {
  it("通过端口运行，并保持旧搜索结果的官方组和标签归一化行为", async () => {
    const getSearchResult = vi.fn().mockResolvedValue({
      data: [
        {
          id: "1",
          site: "demo",
          tags: [{ name: "WEB-DL" }, { name: "WEB-DL" }],
          title: "Official release",
        },
      ],
      status: EResultParseStatus.success,
    } as unknown as ISearchResult);
    const settings: SettingsReader = { get: vi.fn().mockResolvedValue({ searchEntity: { autoDetectOfficialGroupFromTitle: true } }) };
    const query = new SearchQuery({
      http: new InMemoryHttpClient(),
      logger: new InMemoryLogger(),
      settings,
      siteFactory: {
        create: vi.fn().mockResolvedValue({
          getSearchResult,
          metadata: { officialGroupPattern: ["official"] },
        }),
      },
    });

    const result = await query.execute({ keyword: "movie", siteId: "demo" });

    expect(getSearchResult).toHaveBeenCalledWith("movie", {});
    expect(result.data[0].tags?.filter((tag) => tag.name === "官方")).toHaveLength(1);
    expect(result.data[0].tags?.filter((tag) => tag.name === "WEB-DL")).toHaveLength(1);
  });
});

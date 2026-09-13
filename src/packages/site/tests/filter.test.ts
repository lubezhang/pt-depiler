import { describe, expect, it } from "vitest";
import { definedFilters } from "../utils/filter.ts";

describe("definedFilters social URL parsers", () => {
  it("loads and parses supported social-site identifiers", () => {
    expect(definedFilters.extAnidbId("https://anidb.net/anime/123")).toBe("123");
    expect(definedFilters.extBangumiId("https://bgm.tv/subject/456")).toBe("456");
    expect(definedFilters.extDoubanId("https://movie.douban.com/subject/789/")).toBe("789");
    expect(definedFilters.extImdbId("tt1234567")).toBe("tt1234567");
    expect(definedFilters.extTvmazeId("https://www.tvmaze.com/shows/42/test")).toBe("42");
  });
});

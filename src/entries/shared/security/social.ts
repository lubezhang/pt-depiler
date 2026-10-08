import type { ISocialInformation } from "@ptd/social";

export function publicSocialInformation(source: ISocialInformation): ISocialInformation {
  const result = Object.fromEntries(
    [
      "site",
      "id",
      "title",
      "mediaType",
      "pageCategory",
      "seriesTitle",
      "entryTitle",
      "summary",
      "releaseYear",
      "region",
      "genres",
      "ratingScore",
      "ratingCount",
      "createAt",
    ]
      .filter((key) => source[key as keyof ISocialInformation] !== undefined)
      .map((key) => [key, source[key as keyof ISocialInformation]]),
  );
  if (source.external_ids) {
    result.external_ids = Object.fromEntries(
      Object.entries(source.external_ids).filter(
        ([key, value]) =>
          ["imdb", "douban", "bangumi", "anidb", "tvmaze", "tmdb", "tvdb"].includes(key) &&
          /^[A-Za-z0-9_-]{1,64}$/.test(value ?? ""),
      ),
    );
  }
  if (source.poster) {
    try {
      const url = new URL(source.poster);
      if (/^https?:$/.test(url.protocol)) result.poster = url.origin + url.pathname;
    } catch {
      result.poster = "";
    }
  }
  return result as unknown as ISocialInformation;
}

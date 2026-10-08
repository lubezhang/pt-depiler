import { describe, expect, it } from "vitest";
import { redactBackup, withoutBackupKey } from "../entries/offscreen/utils/backupRedaction.ts";
import { reactive } from "vue";
import { entitySummary } from "../entries/shared/security/entities.ts";
import { publicSocialInformation } from "../entries/shared/security/social.ts";
import {
  publicDownloadHistory,
  publicKeepUploadTask,
  publicSearchSnapshot,
} from "../entries/shared/security/artifacts.ts";

const sentinel = "SENSITIVE_SENTINEL_84f17";

describe("AP-04 backup credential boundary", () => {
  it("代理实体列表和持久任务不携带凭据，列表副本不修改原实体", () => {
    expect(
      JSON.stringify(
        publicSocialInformation({
          title: "Movie",
          token: sentinel,
          poster: `https://image.test/poster.jpg?apikey=${sentinel}`,
        } as never),
      ),
    ).not.toContain(sentinel);
    const entity = reactive({
      id: "client",
      password: sentinel,
      address: `https://host.test/rpc?token=${sentinel}`,
      suggestTags: ["tag"],
      advanceAddTorrentOptions: { token: sentinel },
    });
    const summary = entitySummary(entity);
    expect(JSON.stringify(summary)).not.toContain(sentinel);
    summary.suggestTags.push("other");
    expect(entity.suggestTags).toEqual(["tag"]);
    const torrent = {
      id: "1",
      site: "alpha",
      link: `https://host.test/download.php?id=1&passkey=${sentinel}`,
      url: `https://host.test/details.php?id=1&token=${sentinel}`,
    };
    expect(
      JSON.stringify(
        publicDownloadHistory({
          id: 1,
          torrent,
          addTorrentResult: { token: sentinel },
          errorMessage: sentinel,
        } as never),
      ),
    ).not.toContain(sentinel);
    expect(
      JSON.stringify(
        publicKeepUploadTask({
          items: [torrent],
          downloadOptions: { downloaderId: "client", token: sentinel },
          token: sentinel,
        } as never),
      ),
    ).not.toContain(sentinel);
    expect(JSON.stringify(publicSearchSnapshot({ searchResult: [torrent], token: sentinel } as never))).not.toContain(
      sentinel,
    );
  });
  const source = {
    config: {
      lang: "zh_CN",
      theme: "dark",
      backup: { encryptionKey: sentinel, enabledAutoBackup: true },
      customField: sentinel,
    },
    metadata: {
      sites: {
        alpha: {
          url: `https://tracker.example/path/${sentinel}?passkey=${sentinel}`,
          password: sentinel,
          custom: sentinel,
        },
      },
      siteHostMap: { "tracker.example": "alpha" },
      downloaders: {
        client: { type: "qBittorrent", address: `https://host.example/rpc?token=${sentinel}`, password: sentinel },
      },
      backupServers: { backup: { type: "WebDAV", config: { password: sentinel }, enabled: true } },
      unexpected: { innocentName: sentinel },
    },
    userInfo: { alpha: { "2026-10-07": { site: "alpha", uploaded: 100, token: sentinel, custom: sentinel } } },
  };

  it("omits open fields and plaintext credentials while retaining non-secret statistics", () => {
    const redacted = redactBackup(source);
    expect(JSON.stringify(redacted)).not.toContain(sentinel);
    expect(redacted.metadata?.sites.alpha.url).toBe("https://tracker.example");
    expect(redacted.userInfo?.alpha["2026-10-07"].uploaded).toBe(100);
    expect(redacted.metadata?.siteHostMap["tracker.example"]).toBe("alpha");
  });

  it("excludes the backup key even when an encrypted archive carries other credentials", () => {
    const encrypted = withoutBackupKey(source);
    expect(encrypted.config?.backup.encryptionKey).toBe("");
    expect(encrypted.metadata?.sites.alpha.password).toBe(sentinel);
    expect(source.config.backup.encryptionKey).toBe(sentinel);
  });
});

import { describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());

vi.mock("~/extends/axios/resourceClient.ts", () => ({
  legacyDownloaderHttp: { request },
}));

import { getRemoteTorrentFile } from "./utils.ts";

function torrentFixture(): ArrayBuffer {
  const data = Buffer.concat([
    Buffer.from("d4:infod6:lengthi1e4:name4:test12:piece lengthi16384e6:pieces20:"),
    Buffer.alloc(20),
    Buffer.from("ee"),
  ]);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

describe("getRemoteTorrentFile", () => {
  it("accepts a valid torrent with a non-standard content type", async () => {
    request.mockResolvedValue({
      data: torrentFixture(),
      headers: { "content-type": "application/force-download" },
    });

    await expect(
      getRemoteTorrentFile({ url: "https://tracker.test/download" }, { request } as never),
    ).resolves.toMatchObject({
      name: "test.torrent",
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRedirects: 0,
        responseType: "arraybuffer",
        validateStatus: expect.any(Function),
      }),
    );
  });

  it("rejects a response that is not a torrent", async () => {
    request.mockResolvedValue({
      data: new TextEncoder().encode("<html>login</html>").buffer,
      headers: { "content-type": "text/html" },
    });

    await expect(getRemoteTorrentFile({ url: "https://tracker.test/download" }, { request } as never)).rejects.toThrow(
      "Invalid Torrent From Server",
    );
  });

  it("follows a redirect only when the redirect response is not itself a torrent", async () => {
    request
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: "https://tracker.test/notice" },
        data: new TextEncoder().encode("<html>notice</html>").buffer,
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/x-bittorrent" },
        data: torrentFixture(),
      });

    await expect(
      getRemoteTorrentFile({ url: "https://tracker.test/download" }, { request } as never),
    ).resolves.toMatchObject({
      name: "test.torrent",
    });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxRedirects: 10, responseType: "arraybuffer" }),
    );
  });
});

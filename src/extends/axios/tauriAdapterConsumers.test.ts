import axios, { type AxiosAdapter } from "axios";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getItem: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem } }));

import GoogleDrive, { serverConfig as googleDriveConfig } from "@ptd/backupServer/entity/GoogleDrive.ts";
import OWSS, { serverConfig as owssConfig } from "@ptd/backupServer/entity/OWSS.ts";
import Flood from "@ptd/downloader/entity/Flood.ts";
import QBittorrent from "@ptd/downloader/entity/qBittorrent.ts";
import RuTorrent from "@ptd/downloader/entity/ruTorrent.ts";
import SynologyDownloadStation from "@ptd/downloader/entity/synologyDownloadStation.ts";
import UTorrent from "@ptd/downloader/entity/uTorrent.ts";
import { invalidateHostMapCache, tauriAdapter } from "./tauriAdapter.ts";

interface IpcRequest {
  siteId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { kind: "none" } | { kind: "text" | "base64"; data: string };
  timeout?: number;
  binary: boolean;
}

const torrentBytes = new TextEncoder().encode(
  "d4:infod6:lengthi1e4:name1:x12:piece lengthi1e6:pieces20:12345678901234567890ee",
);

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function jsonResponse(req: IpcRequest, data: unknown, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    finalUrl: req.url,
  };
}

function ipcRequests(): IpcRequest[] {
  return mocks.invoke.mock.calls.map(([, payload]) => payload.req as IpcRequest);
}

function findRequest(path: string): IpcRequest {
  const requests = ipcRequests();
  const request = requests.find((candidate) => new URL(candidate.url).pathname === path);
  expect(
    request,
    `未找到 ${path} 请求，实际路径：${requests.map((candidate) => new URL(candidate.url).pathname).join(", ")}`,
  ).toBeDefined();
  return request!;
}

function decodeMultipart(request: IpcRequest): string {
  expect(request.body.kind).toBe("base64");
  return atob(request.body.kind === "base64" ? request.body.data : "");
}

const originalAdapter = axios.defaults.adapter;

describe("Tauri adapter 的下载器与备份请求契约", () => {
  beforeAll(() => {
    axios.defaults.adapter = tauriAdapter;
  });

  afterAll(() => {
    axios.defaults.adapter = originalAdapter;
  });

  beforeEach(() => {
    invalidateHostMapCache();
    mocks.invoke.mockReset();
    mocks.getItem.mockReset();
    mocks.getItem.mockResolvedValue({ siteHostMap: {} });
    mocks.invoke.mockImplementation(async (_command: string, payload: { req: IpcRequest }) => {
      const req = payload.req;
      const url = new URL(req.url);

      if (url.pathname === "/seed/download") {
        return {
          status: 200,
          headers: {
            "content-type": "application/x-bittorrent",
            "content-disposition": 'attachment; filename="fixture.torrent"',
          },
          body: encodeBase64(torrentBytes),
          finalUrl: req.url,
        };
      }
      if (url.pathname === "/api/v2/torrents/add") {
        return { status: 200, headers: { "content-type": "text/plain" }, body: "Ok.", finalUrl: req.url };
      }
      if (url.pathname === "/webapi/query.cgi") {
        return jsonResponse(req, {
          success: true,
          data: { "SYNO.API.Auth": { maxVersion: 7, minVersion: 1, path: "auth.cgi" } },
        });
      }
      if (url.pathname === "/webapi/auth.cgi") {
        return jsonResponse(req, { success: true, data: { sid: "synology-session" } });
      }
      if (url.pathname === "/webapi/entry.cgi") {
        return jsonResponse(req, { success: true, data: { list_id: [], task_id: ["task-1"] } });
      }
      if (url.pathname === "/auth/verify") {
        return jsonResponse(req, { error: "not found" }, 404);
      }
      if (url.pathname === "/api/torrents/add-urls") {
        return jsonResponse(req, {});
      }
      if (url.pathname.endsWith("/php/addtorrent.php")) {
        return jsonResponse(req, { result: "Success" });
      }
      if (url.pathname === "/gui/token.html") {
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html><div>ut-token</div></html>",
          finalUrl: req.url,
        };
      }
      if (url.pathname === "/gui/") {
        return jsonResponse(req, { build: 1 });
      }
      if (url.pathname === "/oauth2/v4/token") {
        return jsonResponse(req, {
          access_token: "google-token",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/drive.appdata",
          token_type: "Bearer",
        });
      }
      if (url.pathname === "/storage/auth-code/add") {
        return jsonResponse(req, { data: true });
      }

      return jsonResponse(req, {});
    });
  });

  it("qBittorrent 本地种子保留文件名、二进制和添加选项", async () => {
    const client = new QBittorrent({
      address: "http://qbittorrent.test",
      username: "",
      password: "qbt_api_key",
    });

    await expect(
      client.addTorrent("https://tracker.test/seed/download", {
        localDownload: true,
        savePath: "/downloads",
        label: "movies",
        addAtPaused: true,
        uploadSpeedLimit: 2,
      }),
    ).resolves.toMatchObject({ success: true });

    const request = findRequest("/api/v2/torrents/add");
    const multipart = decodeMultipart(request);
    expect(request.headers.Authorization).toBe("Bearer qbt_api_key");
    expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(multipart).toContain('name="torrents"; filename="fixture.torrent"');
    expect(multipart).toContain(String.fromCharCode(...torrentBytes));
    expect(multipart).toContain('name="savepath"\r\n\r\n/downloads');
    expect(multipart).toContain('name="tags"\r\n\r\nmovies');
    expect(multipart).toContain('name="paused"\r\n\r\ntrue');
    expect(multipart).toContain('name="stopped"\r\n\r\ntrue');
    expect(multipart).toContain('name="upLimit"\r\n\r\n2097152');
  });

  it("Synology 本地种子使用登录 SID 和 multipart 字段", async () => {
    const client = new SynologyDownloadStation({
      address: "http://synology.test",
      username: "nas-user",
      password: "nas-password",
    });

    await expect(
      client.addTorrent("https://tracker.test/seed/download", {
        localDownload: true,
        savePath: "video",
        addAtPaused: false,
      }),
    ).resolves.toMatchObject({ success: true });

    const auth = findRequest("/webapi/auth.cgi");
    expect(new URL(auth.url).searchParams).toMatchObject({});
    expect(new URL(auth.url).searchParams.get("account")).toBe("nas-user");
    expect(new URL(auth.url).searchParams.get("passwd")).toBe("nas-password");

    const request = findRequest("/webapi/entry.cgi");
    const multipart = decodeMultipart(request);
    expect(multipart).toContain('name="_sid"\r\n\r\nsynology-session');
    expect(multipart).toContain('name="destination"\r\n\r\n"video"');
    expect(multipart).toContain('name="torrent"; filename="fixture.torrent"');
    expect(multipart).toContain(String.fromCharCode(...torrentBytes));
  });

  it("Flood 的 jesec URL 添加请求保持 JSON 数组", async () => {
    const client = new Flood({ address: "http://flood.test", username: "user", password: "password" });
    const magnet = "magnet:?xt=urn:btih:1234567890123456789012345678901234567890";

    await expect(
      client.addTorrent(magnet, { savePath: "/data", label: "tv", addAtPaused: true }),
    ).resolves.toMatchObject({ success: true });

    const request = findRequest("/api/torrents/add-urls");
    expect(request.headers["Content-Type"]).toBe("application/json");
    expect(request.body).toEqual({
      kind: "text",
      data: JSON.stringify({ destination: "/data", tags: ["tv"], start: false, urls: [magnet] }),
    });
  });

  it("ruTorrent 保留 URLSearchParams 和 UTF-8 Basic Auth", async () => {
    const client = new RuTorrent({ address: "https://rutorrent.test", username: "用户", password: "口令" });
    const magnet = "magnet:?xt=urn:btih:1234567890123456789012345678901234567890";

    const result = await client.addTorrent(magnet, { savePath: "/下载", label: "电影" });

    const request = findRequest("/php/addtorrent.php");
    const encoded = request.headers.Authorization.slice("Basic ".length);
    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0)))).toBe("用户:口令");
    expect(request.body.kind).toBe("text");
    const params = new URLSearchParams(request.body.kind === "text" ? request.body.data : "");
    expect(params.get("url")).toBe(magnet);
    expect(params.get("json")).toBe("1");
    expect(params.get("dir_edit")).toBe("/下载");
    expect(params.get("label")).toBe("电影");
    expect(result).toMatchObject({ success: true });
  });

  it("uTorrent 先取 token，再按固定查询参数提交 URL", async () => {
    const client = new UTorrent({ address: "http://utorrent.test", username: "admin", password: "secret" });
    const magnet = "magnet:?xt=urn:btih:1234567890123456789012345678901234567890";

    await expect(client.addTorrent(magnet, { savePath: "/data" })).resolves.toMatchObject({ success: true });

    const request = findRequest("/gui/");
    const query = new URL(request.url).searchParams;
    expect(query.get("token")).toBe("ut-token");
    expect(query.get("action")).toBe("add-url");
    expect(query.get("download_dir")).toBe("0");
    expect(query.get("path")).toBe("/data");
    expect(query.get("s")).toBe(magnet);
    expect(request.body).toEqual({ kind: "none" });
    expect(request.headers.Authorization).toBe(`Basic ${btoa("admin:secret")}`);
  });

  it("Google Drive OAuth 刷新使用单次表单编码", async () => {
    const GoogleDriveConstructor = GoogleDrive as unknown as new (config: typeof googleDriveConfig) => GoogleDrive;
    const client = new GoogleDriveConstructor({
      ...googleDriveConfig,
      config: { client_id: "client+id", client_secret: "中 文", refresh_token: "refresh/token" },
    });

    await expect(client.ping()).resolves.toBe(true);

    const request = findRequest("/oauth2/v4/token");
    expect(request.headers["Content-Type"]).toBe("application/x-www-form-urlencoded;charset=utf-8");
    expect(request.body).toEqual({
      kind: "text",
      data: "client_id=client%2Bid&client_secret=%E4%B8%AD+%E6%96%87&refresh_token=refresh%2Ftoken&grant_type=refresh_token",
    });
  });

  it("OWSS 上传使用带文件名的 multipart ZIP", async () => {
    const OwssConstructor = OWSS as unknown as new (config: typeof owssConfig) => OWSS;
    const client = new OwssConstructor({
      ...owssConfig,
      config: { address: "http://owss.test", authCode: "auth-code" },
    });

    await expect(client.addFile("backup.zip", { settings: { theme: "dark" } })).resolves.toBe(true);

    const request = findRequest("/storage/auth-code/add");
    const multipart = decodeMultipart(request);
    expect(multipart).toContain('name="name"\r\n\r\nbackup.zip');
    expect(multipart).toContain('name="data"; filename="backup.zip"');
    expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  });
});

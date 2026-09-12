import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getItem: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.getItem } }));

import WebDAV, { serverConfig } from "@ptd/backupServer/entity/WebDAV.ts";
import type { IBackupData } from "@ptd/backupServer/type.ts";
import { invalidateHostMapCache } from "./tauriAdapter.ts";

interface IpcRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { kind: "none" } | { kind: "text" | "base64"; data: string };
  binary: boolean;
}

const directoryXml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/webdav/</d:href>
    <d:propstat><d:prop><d:displayname>webdav</d:displayname><d:resourcetype><d:collection /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/webdav/backup.zip</d:href>
    <d:propstat><d:prop><d:displayname>backup.zip</d:displayname><d:resourcetype /><d:getcontentlength>321</d:getcontentlength><d:getlastmodified>Fri, 11 Sep 2026 08:00:00 GMT</d:getlastmodified><d:getetag>fixture</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function textResponse(req: IpcRequest, body: string, status = 200, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { "content-type": "application/xml", ...headers },
    body: base64(new TextEncoder().encode(body)),
    finalUrl: req.url,
  };
}

function requests(): IpcRequest[] {
  return mocks.invoke.mock.calls.map(([, payload]) => payload.req as IpcRequest);
}

function header(request: IpcRequest, name: string): string | undefined {
  return Object.entries(request.headers).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[1];
}

function createWebDAV(digest = false): WebDAV {
  const Constructor = WebDAV as unknown as new (config: typeof serverConfig) => WebDAV;
  return new Constructor({
    ...serverConfig,
    config: {
      address: "https://dav.test/webdav",
      loginName: "backup-user",
      loginPwd: "backup-password",
      digest,
    },
  });
}

describe("WebDAV Tauri transport", () => {
  beforeEach(() => {
    invalidateHostMapCache();
    mocks.invoke.mockReset();
    mocks.getItem.mockReset();
    mocks.getItem.mockResolvedValue({ siteHostMap: {} });
  });

  it("通过 IPC 完成 Basic 认证下的列表、ZIP 上传下载恢复和删除", async () => {
    let uploadedZip = "";
    mocks.invoke.mockImplementation(async (_command: string, payload: { req: IpcRequest }) => {
      const req = payload.req;
      switch (req.method.toUpperCase()) {
        case "PROPFIND":
          return textResponse(req, directoryXml, 207);
        case "PUT":
          expect(req.body.kind).toBe("base64");
          uploadedZip = req.body.kind === "base64" ? req.body.data : "";
          return textResponse(req, "", 201, { "content-type": "text/plain" });
        case "GET":
          return {
            status: 200,
            headers: { "content-type": "application/zip" },
            body: uploadedZip,
            finalUrl: req.url,
          };
        case "DELETE":
          return textResponse(req, "", 204, { "content-type": "text/plain" });
        default:
          throw new Error(`未处理的 WebDAV 方法：${req.method}`);
      }
    });

    const client = createWebDAV();
    await expect(client.list()).resolves.toEqual([
      {
        filename: "backup.zip",
        path: "/backup.zip",
        size: 321,
        time: Date.parse("Fri, 11 Sep 2026 08:00:00 GMT"),
      },
    ]);

    const backup: IBackupData = { settings: { theme: "dark", language: "zh-CN" } };
    await expect(client.addFile("backup.zip", backup)).resolves.toBe(true);
    expect(uploadedZip).not.toBe("");
    await expect(client.getFile("backup.zip")).resolves.toMatchObject({ settings: backup.settings });
    await expect(client.deleteFile("backup.zip")).resolves.toBe(true);

    const [list, upload, download, remove] = requests();
    for (const req of [list, upload, download, remove]) {
      expect(req.binary).toBe(true);
      expect(header(req, "authorization")).toBe(`Basic ${btoa("backup-user:backup-password")}`);
    }
    expect(list.method).toBe("propfind");
    expect(header(list, "depth")).toBe("1");
    expect(upload.method).toBe("put");
    expect(header(upload, "content-type")).toBe("application/octet-stream");
    expect(download.method).toBe("get");
    expect(remove.method).toBe("delete");
  });

  it("保留 webdav-client 的 Digest 401 挑战与授权重试", async () => {
    mocks.invoke
      .mockImplementationOnce(async (_command: string, payload: { req: IpcRequest }) =>
        textResponse(payload.req, "", 401, {
          "www-authenticate": 'Digest realm="dav", nonce="fixture-nonce", qop="auth", algorithm=MD5',
        }),
      )
      .mockImplementationOnce(async (_command: string, payload: { req: IpcRequest }) =>
        textResponse(payload.req, directoryXml, 207),
      );

    await expect(createWebDAV(true).ping()).resolves.toBe(true);

    const [challenge, authorized] = requests();
    expect(header(challenge, "authorization")).toBeUndefined();
    expect(header(authorized, "authorization")).toMatch(/^Digest /);
    expect(header(authorized, "authorization")).toContain('username="backup-user"');
    expect(header(authorized, "authorization")).toContain('realm="dav"');
    expect(header(authorized, "authorization")).toContain('nonce="fixture-nonce"');
    expect(header(authorized, "authorization")).toContain('uri="\/webdav\/"');
    expect(header(authorized, "authorization")).toContain("qop=auth");
  });
});

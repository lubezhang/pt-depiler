import { expect, it, vi } from "vitest";
import { createAccountService } from "./service.ts";

it("AP-15 account use cases operate through supplied ports without a WebView", async () => {
  const open = vi.fn(async () => undefined);
  const finish = vi.fn(async () => 2);
  const request = vi.fn(async () => undefined);
  const site = vi.fn(async () => ({ request }));
  const service = createAccountService({ http: vi.fn(), open, finish, site, cookies: vi.fn(), sleep: vi.fn() });
  const input = { siteId: "fixture", siteUrl: "https://tracker.example/", schema: "NexusPHP" };
  await service.openInteractiveSiteLogin(input);
  expect(open).toHaveBeenCalledWith(input.siteUrl, input.siteUrl);
  await expect(service.finishInteractiveSiteLogin(input)).resolves.toEqual({ cookieCount: 2, finalUrl: input.siteUrl });
  expect(site).toHaveBeenCalledWith("fixture", input.siteUrl);
  expect(request).toHaveBeenCalledWith({ url: "/", responseType: "document" });
  site.mockRejectedValueOnce(new Error("SITE_NOT_CONFIGURED"));
  await expect(service.verifySyncedSiteLogin(input, 1)).rejects.toThrow("SITE_NOT_CONFIGURED");
});

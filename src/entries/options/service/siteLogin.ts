import { invokeIpc } from "~/extends/tauri/ipc.ts";
import { getSite } from "@ptd/site";
import { siteDependencies } from "@/offscreen/adapter/site.ts";
import { extStorage } from "@/storage.ts";
import { sendMessage } from "@/messages.ts";
import { createAccountService } from "~/application/account/service.ts";
export type { SiteLoginInput, SiteLoginResult, PreparedSiteLogin, LoginForm } from "~/application/account/service.ts";
const service = createAccountService({
  http: (siteId) => siteDependencies(siteId).http,
  site: async (siteId, url) => {
    const config = (await extStorage.getItem("metadata"))?.sites?.[siteId];
    if (!config) throw new Error("SITE_NOT_CONFIGURED");
    if (config.url && new URL(config.url).origin !== new URL(url).origin) throw new Error("SITE_CONFIGURATION_CHANGED");
    return getSite(siteId, { ...config, url: (config.url ?? url) as never }, siteDependencies(siteId));
  },
  open: (siteUrl, loginUrl) => invokeIpc("open_site_login", { siteUrl, loginUrl }),
  finish: (siteUrl) => invokeIpc("finish_site_login", { siteUrl }),
  cookies: (domain) => sendMessage("getAllCookies", { domain }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
export const {
  openInteractiveSiteLogin,
  finishInteractiveSiteLogin,
  verifySyncedSiteLogin,
  prepareSiteLogin,
  getCaptchaImage,
  reportCaptchaImageRenderFailure,
  loginSite,
} = service;

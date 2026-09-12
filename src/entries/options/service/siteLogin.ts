import axios from "axios";
import { invoke } from "@tauri-apps/api/core";
import { getSite, NeedLoginError, type TSiteID, type TSiteUrl } from "@ptd/site";
import { sendMessage } from "@/messages.ts";
import {
  buildLoginSubmissionFields,
  findLoginForm,
  validateLoginResponsePage,
  type LoginForm,
  type PreparedSiteLogin,
} from "./siteLoginCore.ts";

export type { LoginForm, PreparedSiteLogin } from "./siteLoginCore.ts";

export interface SiteLoginInput {
  siteId: TSiteID;
  siteUrl: string;
  schema?: string;
  username: string;
  password: string;
  loginPath?: string;
  remember: boolean;
}

export interface SiteLoginResult {
  cookieCount: number;
  finalUrl: string;
}

type InteractiveSiteLoginInput = Pick<SiteLoginInput, "siteId" | "siteUrl" | "schema" | "loginPath">;

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return `axios code=${error.code ?? ""} status=${error.response?.status ?? ""} message=${error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function writeLoginDebugLog(message: string): Promise<void> {
  try {
    await invoke("write_debug_log", { message: `login ${message}` });
  } catch {
    // 调试日志不可影响正常登录流程。
  }
}

function getDefaultLoginPath(schema?: string): string {
  if (schema === "Unit3D") return "/login";
  return "/login.php";
}

function resolveUrl(path: string, siteUrl: string): string {
  return new URL(path, siteUrl).toString();
}

function isTransientHttp400(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    return error.response?.status === 400;
  }
  return error instanceof Error && /(?:Network Error:|HTTP)\s*400(?!\d)/.test(error.message);
}

export async function openInteractiveSiteLogin(
  input: Pick<InteractiveSiteLoginInput, "siteUrl" | "schema" | "loginPath">,
): Promise<void> {
  const loginUrl = resolveUrl(input.loginPath?.trim() || getDefaultLoginPath(input.schema), input.siteUrl);
  await invoke("open_site_login", { siteUrl: input.siteUrl, loginUrl });
}

export async function finishInteractiveSiteLogin(input: InteractiveSiteLoginInput): Promise<SiteLoginResult> {
  const cookieCount = await invoke<number>("finish_site_login", { siteUrl: input.siteUrl });
  if (cookieCount === 0) {
    throw new Error("没有从站点登录窗口获取到 Cookie。请先在该窗口完成登录。");
  }
  try {
    await verifyLoggedIn(input.siteId, input.siteUrl);
  } catch (error) {
    if (error instanceof NeedLoginError) {
      throw new Error("Cookie 已同步，但站点仍返回未登录状态。请重新打开登录窗口并完成全部验证步骤。");
    }
    throw error;
  }
  return { cookieCount, finalUrl: input.siteUrl };
}

export async function prepareSiteLogin(input: Pick<SiteLoginInput, "siteUrl" | "schema" | "loginPath">) {
  const loginPageUrl = resolveUrl(input.loginPath?.trim() || getDefaultLoginPath(input.schema), input.siteUrl);
  await writeLoginDebugLog(`prepare_page url=${redactUrl(loginPageUrl)} schema=${input.schema ?? ""}`);
  const requestConfig = {
    responseType: "document",
    validateStatus: () => true,
  } as const;
  let response = await axios.get<Document>(loginPageUrl, requestConfig);

  // 部分站点偶发以短 400 页响应首次匿名 GET；登录页读取是幂等操作，重试一次即可避免误报。
  if (response.status === 400) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await axios.get<Document>(loginPageUrl, requestConfig);
  }

  const { data: loginPage, status } = response;
  await writeLoginDebugLog(
    `prepare_page_response url=${redactUrl(loginPageUrl)} status=${status} forms=${loginPage.forms.length}`,
  );
  if (status >= 400) {
    throw new Error(`登录页请求失败（HTTP ${status}）。请检查登录页路径或站点可用性。`);
  }
  const prepared = findLoginForm(loginPage, loginPageUrl);
  await writeLoginDebugLog(
    `form_detected action=${redactUrl(prepared.form.action)} method=${prepared.form.method} captcha=${Boolean(prepared.captcha)} captcha_url=${prepared.captcha?.imageUrl ? redactUrl(prepared.captcha.imageUrl) : ""} hidden_fields=${Array.from(prepared.form.fields.keys()).length}`,
  );
  return prepared;
}

export async function getCaptchaImage(prepared: PreparedSiteLogin): Promise<string | undefined> {
  const imageUrl = prepared.captcha?.imageUrl;
  if (!imageUrl) {
    await writeLoginDebugLog(
      `captcha_fetch_skipped reason=missing_image_url field=${prepared.captcha?.fieldName ?? ""}`,
    );
    return;
  }

  await writeLoginDebugLog(`captcha_fetch_start url=${redactUrl(imageUrl)}`);
  try {
    const { data, status, headers } = await axios.get<Blob>(imageUrl, {
      responseType: "blob",
      validateStatus: () => true,
    });
    const contentType = String(headers["content-type"] ?? "");
    await writeLoginDebugLog(
      `captcha_fetch_response url=${redactUrl(imageUrl)} status=${status} content_type=${contentType} size=${data.size} blob_type=${data.type}`,
    );
    if (status < 200 || status >= 300) {
      throw new Error(`验证码图片请求失败（HTTP ${status}）。`);
    }
    if (!contentType.toLowerCase().startsWith("image/") || data.size === 0) {
      throw new Error(`验证码图片响应不是有效图片（Content-Type: ${contentType || "unknown"}，大小: ${data.size}）。`);
    }
    return URL.createObjectURL(data);
  } catch (error) {
    await writeLoginDebugLog(`captcha_fetch_failed url=${redactUrl(imageUrl)} error=${describeError(error)}`);
    throw error;
  }
}

export async function reportCaptchaImageRenderFailure(prepared?: PreparedSiteLogin): Promise<void> {
  await writeLoginDebugLog(
    `captcha_render_failed url=${prepared?.captcha?.imageUrl ? redactUrl(prepared.captcha.imageUrl) : ""}`,
  );
}

async function getCookieCount(siteUrl: string): Promise<number> {
  const host = new URL(siteUrl).hostname;
  const cookies = await sendMessage("getAllCookies", { domain: host });
  return cookies.length;
}

async function verifyLoggedIn(siteId: TSiteID, siteUrl: string): Promise<void> {
  const site = await getSite(siteId, { url: siteUrl as TSiteUrl });
  try {
    await site.request({ url: "/", responseType: "document" });
  } catch (error) {
    if (!isTransientHttp400(error)) {
      throw error;
    }
    await writeLoginDebugLog("verify_retry status=400");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await site.request({ url: "/", responseType: "document" });
  }
}

/**
 * Submit a site's own HTML login form through the shared Tauri HTTP client.
 * Its Set-Cookie response is therefore written into the Cookie Jar that every
 * subsequent site request already uses.
 */
export async function loginSite(
  input: SiteLoginInput,
  prepared: PreparedSiteLogin,
  captcha?: string,
): Promise<SiteLoginResult> {
  if (prepared.captcha && !captcha?.trim()) {
    throw new Error("请输入图形验证码后再登录。");
  }

  const { form } = prepared;
  const fields = buildLoginSubmissionFields(prepared, { ...input, captcha });

  const requestConfig = {
    method: form.method,
    url: form.action,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    responseType: "document" as const,
    validateStatus: () => true,
  };
  const response =
    form.method === "get"
      ? await axios.request({ ...requestConfig, params: fields })
      : await axios.request({ ...requestConfig, data: fields });
  if (response.status >= 400) {
    throw new Error(`站点拒绝登录请求（HTTP ${response.status}）。请检查账号密码或验证码。`);
  }
  const finalUrl = validateLoginResponsePage(
    response.data,
    String(response.request?.responseURL ?? response.config.url ?? ""),
    input.siteUrl,
  );
  await writeLoginDebugLog(
    `submit_response status=${response.status} final_url=${redactUrl(finalUrl)} forms=${response.data.forms.length}`,
  );

  const cookieCount = await getCookieCount(input.siteUrl);
  if (cookieCount === 0) {
    throw new Error("登录请求未获取到 Cookie。请确认账号密码、登录地址，或改用站点的浏览器登录流程。");
  }

  try {
    await verifyLoggedIn(input.siteId, input.siteUrl);
  } catch (error) {
    if (error instanceof NeedLoginError) {
      throw new Error("站点仍返回未登录状态。请确认账号密码，或完成验证码、二次验证后再试。");
    }
    throw error;
  }

  return { cookieCount, finalUrl };
}

export interface CookieInfo {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite?: string;
}

type CookieSetInput = Partial<chrome.cookies.SetDetails> & Partial<Pick<chrome.cookies.Cookie, "hostOnly">>;

export function buildCookieUrl(secure: boolean, domain: string, path: string): string {
  return `http${secure ? "s" : ""}://${domain.replace(/^\./, "")}${path}`;
}

export function redactCookieUrl(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "<invalid-url>";
  }
}

function mapSameSiteToChrome(s?: string): chrome.cookies.SameSiteStatus {
  if (s === "strict") return "strict" as chrome.cookies.SameSiteStatus;
  if (s === "lax") return "lax" as chrome.cookies.SameSiteStatus;
  if (s === "none") return "no_restriction" as chrome.cookies.SameSiteStatus;
  return "unspecified" as chrome.cookies.SameSiteStatus;
}

function mapSameSiteToRust(s?: string): string | undefined {
  if (s === "strict") return "strict";
  if (s === "lax") return "lax";
  if (s === "no_restriction") return "none";
  return undefined;
}

export function toChromeCookie(cookie: CookieInfo): chrome.cookies.Cookie {
  return {
    name: cookie.name ?? "",
    value: cookie.value ?? "",
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    session: cookie.expirationDate == null,
    expirationDate: cookie.expirationDate,
    sameSite: mapSameSiteToChrome(cookie.sameSite),
    storeId: "0",
  };
}

export function toCookieInfo(cookie: CookieSetInput): CookieInfo {
  let urlDomain: string | undefined;
  if (cookie.url) {
    try {
      urlDomain = new URL(cookie.url).hostname;
    } catch {
      throw new Error("Cookie URL 无效");
    }
  }
  const domain = cookie.domain ?? urlDomain;
  if (!domain) {
    throw new Error("Cookie 缺少 domain 或 url");
  }

  return {
    name: cookie.name ?? "",
    value: cookie.value ?? "",
    domain,
    hostOnly: cookie.hostOnly ?? cookie.domain === undefined,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    expirationDate: cookie.expirationDate,
    sameSite: mapSameSiteToRust(cookie.sameSite as string | undefined),
  };
}

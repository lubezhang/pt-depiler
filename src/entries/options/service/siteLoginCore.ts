export interface PreparedSiteLogin {
  captcha?: {
    fieldName: string;
    imageUrl?: string;
  };
  form: LoginForm;
}

export interface LoginForm {
  action: string;
  method: "get" | "post";
  usernameField: string;
  passwordField: string;
  rememberField?: { name: string; value: string };
  fields: URLSearchParams;
}

export interface LoginSubmissionInput {
  username: string;
  password: string;
  remember: boolean;
  captcha?: string;
}

function resolveUrl(path: string, siteUrl: string): string {
  return new URL(path, siteUrl).toString();
}

export function findLoginForm(document: Document, pageUrl: string): PreparedSiteLogin {
  const form = Array.from(document.forms).find((item) => item.querySelector("input[type='password']"));
  if (!form) {
    throw new Error("未在登录页找到账号密码表单；该站点可能使用单点登录或其他非表单登录方式。");
  }

  const usernameInput =
    form.querySelector<HTMLInputElement>(
      "input[autocomplete='username'], input[name*='user' i], input[name*='email' i]",
    ) ??
    Array.from(form.querySelectorAll<HTMLInputElement>("input[type='text'], input[type='email']")).find(
      (item) => !!item.name,
    );
  const passwordInput = form.querySelector<HTMLInputElement>("input[type='password'][name]");
  if (!usernameInput?.name || !passwordInput?.name) {
    throw new Error("登录表单缺少可识别的账号或密码字段。");
  }

  const fields = new URLSearchParams();
  for (const input of form.querySelectorAll<HTMLInputElement>("input[type='hidden'][name]")) {
    fields.set(input.name, input.value);
  }

  const rememberInput = form.querySelector<HTMLInputElement>(
    "input[type='checkbox'][name*='remember' i], input[type='checkbox'][name*='keep' i]",
  );
  const captchaInput = Array.from(form.querySelectorAll<HTMLInputElement>("input[name]"))
    .filter((input) => input.type !== "hidden" && input !== usernameInput && input !== passwordInput)
    .find((input) => /captcha|image|string|verify|code/i.test(input.name));
  const captchaImage = captchaInput
    ? form.querySelector<HTMLImageElement>("img[alt*='captcha' i], img[src*='image' i], img[src*='captcha' i]")
    : null;

  return {
    captcha: captchaInput?.name
      ? {
          fieldName: captchaInput.name,
          imageUrl: captchaImage?.getAttribute("src")
            ? resolveUrl(captchaImage.getAttribute("src")!, pageUrl)
            : undefined,
        }
      : undefined,
    form: {
      action: resolveUrl(form.getAttribute("action") || pageUrl, pageUrl),
      method: form.method.toLowerCase() === "get" ? "get" : "post",
      usernameField: usernameInput.name,
      passwordField: passwordInput.name,
      rememberField: rememberInput?.name ? { name: rememberInput.name, value: rememberInput.value || "1" } : undefined,
      fields,
    },
  };
}

export function buildLoginSubmissionFields(prepared: PreparedSiteLogin, input: LoginSubmissionInput): URLSearchParams {
  const { form } = prepared;
  const fields = new URLSearchParams(form.fields);
  fields.set(form.usernameField, input.username);
  fields.set(form.passwordField, input.password);
  if (form.rememberField && input.remember) {
    fields.set(form.rememberField.name, form.rememberField.value);
  }
  if (prepared.captcha && input.captcha) {
    fields.set(prepared.captcha.fieldName, input.captcha.trim());
  }
  return fields;
}

function hostsAreRelated(first: string, second: string): boolean {
  return first === second || first.endsWith(`.${second}`) || second.endsWith(`.${first}`);
}

export function validateLoginResponsePage(document: Document, finalUrl: string, siteUrl: string): string {
  let final: URL;
  let site: URL;
  try {
    final = new URL(finalUrl);
    site = new URL(siteUrl);
  } catch {
    throw new Error("登录请求未返回有效的最终地址。");
  }

  if (!hostsAreRelated(final.hostname, site.hostname)) {
    throw new Error(`登录请求被重定向到非本站地址：${final.origin}`);
  }
  if (document.querySelector("form input[type='password']")) {
    throw new Error("登录后的最终页面仍显示账号密码表单。请检查账号密码、验证码或二次验证状态。");
  }
  return final.toString();
}

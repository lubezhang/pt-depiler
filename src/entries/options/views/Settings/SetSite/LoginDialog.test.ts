import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCaptchaImage: vi.fn(),
  loginSite: vi.fn(),
  listen: vi.fn(),
  openInteractiveSiteLogin: vi.fn(),
  prepareSiteLogin: vi.fn(),
  reportCaptchaImageRenderFailure: vi.fn(),
  verifySyncedSiteLogin: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/options/service/siteLogin.ts", () => ({
  getCaptchaImage: mocks.getCaptchaImage,
  loginSite: mocks.loginSite,
  openInteractiveSiteLogin: mocks.openInteractiveSiteLogin,
  prepareSiteLogin: mocks.prepareSiteLogin,
  reportCaptchaImageRenderFailure: mocks.reportCaptchaImageRenderFailure,
  verifySyncedSiteLogin: mocks.verifySyncedSiteLogin,
}));

import LoginDialog from "./LoginDialog.vue";

const originalRevokeObjectUrl = URL.revokeObjectURL;

const VTextField = defineComponent({
  name: "VTextField",
  props: { modelValue: { type: String, default: "" }, label: { type: String, default: "" } },
  emits: ["update:modelValue"],
  template:
    '<input :data-label="label" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

const VCheckbox = defineComponent({
  name: "VCheckbox",
  props: { modelValue: { type: Boolean, default: false } },
  emits: ["update:modelValue"],
  template: '<input type="checkbox" :checked="modelValue" />',
});

const VBtn = defineComponent({
  name: "VBtn",
  props: { disabled: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
  emits: ["click"],
  template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

const passthrough = (name: string) =>
  defineComponent({
    name,
    template: "<div><slot /></div>",
  });

const stubs = {
  VAlert: passthrough("VAlert"),
  VBtn,
  VCard: passthrough("VCard"),
  VCardActions: passthrough("VCardActions"),
  VCardSubtitle: passthrough("VCardSubtitle"),
  VCardText: passthrough("VCardText"),
  VCardTitle: passthrough("VCardTitle"),
  VCheckbox,
  VDialog: passthrough("VDialog"),
  VDivider: passthrough("VDivider"),
  VImg: passthrough("VImg"),
  VSpacer: passthrough("VSpacer"),
  VTextField,
};

function preparedLogin(withCaptcha = false) {
  return {
    captcha: withCaptcha
      ? { fieldName: "imagestring", imageUrl: "https://tracker.example/image.php?id=123" }
      : undefined,
    form: {
      action: "https://tracker.example/takelogin.php",
      method: "post" as const,
      usernameField: "username",
      passwordField: "password",
      fields: new URLSearchParams({ csrf: "token" }),
    },
  };
}

async function openDialog(): Promise<VueWrapper> {
  const wrapper = mount(LoginDialog, {
    props: {
      modelValue: false,
      siteId: "fixture-site" as never,
      siteUrl: "https://tracker.example/",
      schema: "NexusPHP",
    },
    global: { stubs },
  });
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  return wrapper;
}

async function enterCredentials(wrapper: VueWrapper, password = "plain-secret") {
  await wrapper.get('[data-testid="toggle-advanced-login"]').trigger("click");
  await wrapper.get('[data-label="common.username"]').setValue("alice");
  await wrapper.get('[data-label="SetSite.login.password"]').setValue(password);
}

function passwordValue(wrapper: VueWrapper): string {
  return (wrapper.get('[data-label="SetSite.login.password"]').element as HTMLInputElement).value;
}

beforeEach(() => {
  mocks.getCaptchaImage.mockReset();
  mocks.loginSite.mockReset();
  mocks.listen.mockReset();
  mocks.openInteractiveSiteLogin.mockReset();
  mocks.prepareSiteLogin.mockReset();
  mocks.reportCaptchaImageRenderFailure.mockReset();
  mocks.verifySyncedSiteLogin.mockReset();
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.prepareSiteLogin.mockResolvedValue(preparedLogin());
  mocks.getCaptchaImage.mockResolvedValue(undefined);
  mocks.openInteractiveSiteLogin.mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalRevokeObjectUrl) {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

describe("LoginDialog 密码生命周期", () => {
  it("登录成功后立即清空密码", async () => {
    mocks.loginSite.mockResolvedValue({ cookieCount: 1, finalUrl: "https://tracker.example/" });
    const wrapper = await openDialog();
    await enterCredentials(wrapper);

    await wrapper.get('[data-testid="submit-form-login"]').trigger("click");
    await flushPromises();

    expect(mocks.loginSite).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice", password: "plain-secret" }),
      expect.any(Object),
      "",
    );
    await wrapper.setProps({ modelValue: false });
    await wrapper.setProps({ modelValue: true });
    await flushPromises();
    await wrapper.get('[data-testid="toggle-advanced-login"]').trigger("click");
    expect(passwordValue(wrapper)).toBe("");
    wrapper.unmount();
  });

  it("登录失败后先清空密码，再刷新 token 和验证码准备态", async () => {
    mocks.loginSite.mockRejectedValue(new Error("invalid credentials"));
    const wrapper = await openDialog();
    await enterCredentials(wrapper);

    await wrapper.get('[data-testid="submit-form-login"]').trigger("click");
    await flushPromises();

    expect(passwordValue(wrapper)).toBe("");
    expect(mocks.prepareSiteLogin).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("invalid credentials");
    wrapper.unmount();
  });

  it("关闭弹窗时清空尚未提交的密码", async () => {
    const wrapper = await openDialog();
    await enterCredentials(wrapper);
    expect(passwordValue(wrapper)).toBe("plain-secret");

    await wrapper.setProps({ modelValue: false });
    await wrapper.setProps({ modelValue: true });
    await flushPromises();
    await wrapper.get('[data-testid="toggle-advanced-login"]').trigger("click");
    expect(passwordValue(wrapper)).toBe("");
    wrapper.unmount();
  });

  it("缺少验证码时刷新图片并释放上一张对象 URL", async () => {
    mocks.prepareSiteLogin.mockResolvedValue(preparedLogin(true));
    mocks.getCaptchaImage.mockResolvedValueOnce("blob:first").mockResolvedValueOnce("blob:second");
    const revokeObjectUrl = vi.fn();
    URL.revokeObjectURL = revokeObjectUrl;
    const wrapper = await openDialog();
    await enterCredentials(wrapper);

    await wrapper.get('[data-testid="submit-form-login"]').trigger("click");
    await flushPromises();

    expect(mocks.getCaptchaImage).toHaveBeenCalledTimes(2);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:first");
    expect(mocks.loginSite).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:second");
  });

  it("组件卸载时释放验证码对象 URL", async () => {
    mocks.prepareSiteLogin.mockResolvedValue(preparedLogin(true));
    mocks.getCaptchaImage.mockResolvedValue("blob:captcha");
    const revokeObjectUrl = vi.fn();
    URL.revokeObjectURL = revokeObjectUrl;
    const wrapper = await openDialog();
    await enterCredentials(wrapper);
    await wrapper.get('[data-testid="submit-form-login"]').trigger("click");
    await flushPromises();

    wrapper.unmount();

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:captcha");
  });

  it("打开弹窗即进入网站登录，关闭网站窗口后自动验证 Cookie", async () => {
    mocks.verifySyncedSiteLogin.mockResolvedValue({
      cookieCount: 2,
      finalUrl: "https://tracker.example/",
    });
    const wrapper = await openDialog();
    expect(mocks.openInteractiveSiteLogin).toHaveBeenCalledWith({
      siteId: "fixture-site",
      siteUrl: "https://tracker.example/",
      schema: "NexusPHP",
      loginPath: "",
    });
    expect(wrapper.text()).not.toContain("SetSite.login.formFallback");
    const onClose = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => void;
    onClose({ payload: { siteUrl: "https://tracker.example/", cookieCount: 2 } });
    await flushPromises();
    expect(mocks.verifySyncedSiteLogin).toHaveBeenCalledWith(
      { siteId: "fixture-site", siteUrl: "https://tracker.example/" },
      2,
    );
    expect(wrapper.emitted("success")?.[0]).toEqual([2]);
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([false]);
    wrapper.unmount();
  });

  it("自动同步失败时保留重试入口并隐藏高级表单", async () => {
    mocks.verifySyncedSiteLogin.mockRejectedValue(new Error("尚未登录"));
    const wrapper = await openDialog();
    const onClose = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => void;
    onClose({ payload: { siteUrl: "https://tracker.example/", cookieCount: 1 } });
    await flushPromises();

    expect(wrapper.text()).toContain("尚未登录");
    expect(wrapper.find('[data-testid="open-browser-login"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("SetSite.login.formFallback");
    wrapper.unmount();
  });

  it("Cookie 同步错误时给出提示，其他站点的关闭事件不改变当前登录", async () => {
    const wrapper = await openDialog();
    const onClose = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => void;
    onClose({ payload: { siteUrl: "https://other.example/", cookieCount: 1 } });
    await flushPromises();
    expect(mocks.verifySyncedSiteLogin).not.toHaveBeenCalled();

    onClose({ payload: { siteUrl: "https://tracker.example/", cookieCount: 0, error: "同步失败" } });
    await flushPromises();
    expect(wrapper.text()).toContain("同步失败");
    expect(mocks.verifySyncedSiteLogin).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

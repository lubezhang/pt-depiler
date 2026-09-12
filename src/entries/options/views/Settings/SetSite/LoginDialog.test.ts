import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finishInteractiveSiteLogin: vi.fn(),
  getCaptchaImage: vi.fn(),
  loginSite: vi.fn(),
  openInteractiveSiteLogin: vi.fn(),
  prepareSiteLogin: vi.fn(),
  reportCaptchaImageRenderFailure: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/options/service/siteLogin.ts", () => ({
  finishInteractiveSiteLogin: mocks.finishInteractiveSiteLogin,
  getCaptchaImage: mocks.getCaptchaImage,
  loginSite: mocks.loginSite,
  openInteractiveSiteLogin: mocks.openInteractiveSiteLogin,
  prepareSiteLogin: mocks.prepareSiteLogin,
  reportCaptchaImageRenderFailure: mocks.reportCaptchaImageRenderFailure,
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
  await wrapper.get('[data-label="common.username"]').setValue("alice");
  await wrapper.get('[data-label="SetSite.login.password"]').setValue(password);
}

function passwordValue(wrapper: VueWrapper): string {
  return (wrapper.get('[data-label="SetSite.login.password"]').element as HTMLInputElement).value;
}

beforeEach(() => {
  mocks.finishInteractiveSiteLogin.mockReset();
  mocks.getCaptchaImage.mockReset();
  mocks.loginSite.mockReset();
  mocks.openInteractiveSiteLogin.mockReset();
  mocks.prepareSiteLogin.mockReset();
  mocks.reportCaptchaImageRenderFailure.mockReset();
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

  it("在站点窗口完成登录后同步 Cookie 并显示成功状态", async () => {
    mocks.finishInteractiveSiteLogin.mockResolvedValue({
      cookieCount: 2,
      finalUrl: "https://tracker.example/",
    });
    const wrapper = await openDialog();

    await wrapper.get('[data-testid="open-browser-login"]').trigger("click");
    await flushPromises();
    expect(mocks.openInteractiveSiteLogin).toHaveBeenCalledWith({
      siteUrl: "https://tracker.example/",
      schema: "NexusPHP",
      loginPath: "",
    });

    await wrapper.get('[data-testid="finish-browser-login"]').trigger("click");
    await flushPromises();
    expect(mocks.finishInteractiveSiteLogin).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "fixture-site", siteUrl: "https://tracker.example/" }),
    );
    expect(wrapper.text()).toContain("SetSite.login.success");
    wrapper.unmount();
  });
});

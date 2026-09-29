<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TSiteID } from "@ptd/site";

import {
  getCaptchaImage,
  loginSite,
  openInteractiveSiteLogin,
  prepareSiteLogin,
  reportCaptchaImageRenderFailure,
  verifySyncedSiteLogin,
  type PreparedSiteLogin,
} from "@/options/service/siteLogin.ts";

const showDialog = defineModel<boolean>({ default: false });
const props = defineProps<{
  siteId: TSiteID;
  siteUrl?: string;
  schema?: string;
}>();
const emit = defineEmits<{ (e: "success", cookieCount: number): void }>();

interface SiteLoginClosedEvent {
  siteUrl: string;
  cookieCount: number;
  error?: string;
}

const { t } = useI18n();
const username = ref("");
const password = ref("");
const loginPath = ref("");
const remember = ref(true);
const showPassword = ref(false);
const loading = ref(false);
const errorMessage = ref("");
const noticeMessage = ref("");
const showAdvanced = ref(false);
const captcha = ref("");
const captchaImageUrl = ref<string>();
const preparedLogin = shallowRef<PreparedSiteLogin>();
const browserLoginOpened = ref(false);
const canSubmit = computed(() => !!props.siteUrl && !!username.value && !!password.value && !loading.value);
const siteHost = computed(() => {
  try {
    return props.siteUrl ? new URL(props.siteUrl).host : "";
  } catch {
    return "";
  }
});
let unlistenClose: UnlistenFn | undefined;
let closeListenerPromise: Promise<void> | undefined;
let disposed = false;

async function ensureCloseListener() {
  closeListenerPromise ??= listen<SiteLoginClosedEvent>("site-login://closed", (event) => {
    void handleBrowserClosed(event.payload);
  }).then((unlisten) => {
    if (disposed) unlisten();
    else unlistenClose = unlisten;
  });
  try {
    await closeListenerPromise;
  } catch (error) {
    closeListenerPromise = undefined;
    throw error;
  }
}

async function handleBrowserClosed(event: SiteLoginClosedEvent) {
  if (!browserLoginOpened.value || !props.siteUrl) return;
  try {
    if (new URL(event.siteUrl).host !== siteHost.value) return;
  } catch {
    return;
  }
  browserLoginOpened.value = false;
  loading.value = true;
  errorMessage.value = "";
  noticeMessage.value = t("SetSite.login.verifying");
  try {
    if (event.error) throw new Error(event.error);
    const result = await verifySyncedSiteLogin({ siteId: props.siteId, siteUrl: props.siteUrl }, event.cookieCount);
    emit("success", result.cookieCount);
    showDialog.value = false;
  } catch (error) {
    noticeMessage.value = "";
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

function clearPreparedLogin() {
  if (captchaImageUrl.value) {
    URL.revokeObjectURL(captchaImageUrl.value);
  }
  captcha.value = "";
  captchaImageUrl.value = undefined;
  preparedLogin.value = undefined;
}

function clearSensitiveState() {
  password.value = "";
  clearPreparedLogin();
}

async function openBrowserLogin() {
  if (!props.siteUrl) return;
  loading.value = true;
  errorMessage.value = "";
  try {
    await ensureCloseListener();
    browserLoginOpened.value = true;
    await openInteractiveSiteLogin({
      siteUrl: props.siteUrl,
      schema: props.schema,
      loginPath: loginPath.value,
    });
    if (browserLoginOpened.value && showDialog.value) {
      noticeMessage.value = t("SetSite.login.browserOpened");
    }
  } catch (error) {
    browserLoginOpened.value = false;
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function refreshCaptchaImage(prepared: PreparedSiteLogin) {
  const nextImageUrl = await getCaptchaImage(prepared);
  if (captchaImageUrl.value && captchaImageUrl.value !== nextImageUrl) {
    URL.revokeObjectURL(captchaImageUrl.value);
  }
  captchaImageUrl.value = nextImageUrl;
}

function handleCaptchaImageError() {
  void reportCaptchaImageRenderFailure(preparedLogin.value);
}

watch(showDialog, (visible) => {
  if (!visible) {
    clearSensitiveState();
    errorMessage.value = "";
    noticeMessage.value = "";
    browserLoginOpened.value = false;
    showAdvanced.value = false;
    return;
  }
  void openBrowserLogin();
});

watch(loginPath, clearPreparedLogin);
onBeforeUnmount(() => {
  disposed = true;
  unlistenClose?.();
  clearSensitiveState();
});

async function prepareLoginPage() {
  if (!props.siteUrl || preparedLogin.value) return;
  loading.value = true;
  errorMessage.value = "";
  noticeMessage.value = "";
  try {
    preparedLogin.value = await prepareSiteLogin({
      siteUrl: props.siteUrl,
      schema: props.schema,
      loginPath: loginPath.value,
    });
    if (preparedLogin.value.captcha) {
      await refreshCaptchaImage(preparedLogin.value);
      noticeMessage.value = t("SetSite.login.captchaRequired");
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!props.siteUrl) return;
  loading.value = true;
  errorMessage.value = "";
  noticeMessage.value = "";
  try {
    const input = {
      siteId: props.siteId,
      siteUrl: props.siteUrl,
      schema: props.schema,
      username: username.value,
      password: password.value,
      loginPath: loginPath.value,
      remember: remember.value,
    };
    if (!preparedLogin.value) {
      await prepareLoginPage();
    }
    if (!preparedLogin.value) {
      password.value = "";
      return;
    }
    if (preparedLogin.value.captcha && !captcha.value.trim()) {
      await refreshCaptchaImage(preparedLogin.value);
      noticeMessage.value = t("SetSite.login.captchaRequired");
      return;
    }
    const result = await loginSite(input, preparedLogin.value, captcha.value);
    clearSensitiveState();
    emit("success", result.cookieCount);
    showDialog.value = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clearSensitiveState();
    await prepareLoginPage();
    errorMessage.value = message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="showDialog" max-width="520" persistent>
    <v-card>
      <v-card-title>{{ t("SetSite.login.title") }}</v-card-title>
      <v-card-subtitle>{{ siteHost }}</v-card-subtitle>
      <v-card-text>
        <v-alert v-if="noticeMessage" class="mb-4" density="compact" type="info" variant="tonal">
          {{ noticeMessage }}
        </v-alert>
        <v-alert v-if="errorMessage" class="mb-4" density="compact" type="error" variant="tonal">
          {{ errorMessage }}
        </v-alert>
        <v-btn
          block
          color="primary"
          data-testid="open-browser-login"
          prepend-icon="mdi-open-in-new"
          variant="flat"
          :loading="loading"
          @click="openBrowserLogin"
        >
          {{ t(browserLoginOpened ? "SetSite.login.returnBrowser" : "SetSite.login.openBrowser") }}
        </v-btn>
        <v-btn
          class="mt-4 px-0"
          data-testid="toggle-advanced-login"
          :append-icon="showAdvanced ? 'mdi-chevron-up' : 'mdi-chevron-down'"
          variant="text"
          @click="showAdvanced = !showAdvanced"
        >
          {{ t("SetSite.login.advanced") }}
        </v-btn>
        <div v-if="showAdvanced" class="mt-2">
          <v-text-field
            v-model="loginPath"
            :hint="t('SetSite.login.loginPathHint')"
            :label="t('SetSite.login.loginPath')"
            persistent-hint
          />
          <v-divider class="my-4" />
          <div class="text-subtitle-2 mb-3">{{ t("SetSite.login.formFallback") }}</div>
          <v-text-field v-model="username" :label="t('common.username')" autocomplete="username" />
          <v-text-field
            v-model="password"
            :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
            :label="t('SetSite.login.password')"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="current-password"
            @click:append-inner="showPassword = !showPassword"
          />
          <template v-if="preparedLogin?.captcha">
            <v-img
              v-if="captchaImageUrl"
              :src="captchaImageUrl"
              class="mt-4 border"
              height="96"
              max-width="240"
              contain
              @error="handleCaptchaImageError"
            />
            <v-text-field v-model="captcha" :label="t('SetSite.login.captcha')" autocomplete="off" class="mt-2" />
          </template>
          <v-checkbox v-model="remember" :label="t('SetSite.login.remember')" density="compact" hide-details />
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="loading" variant="text" @click="showDialog = false">{{ t("common.dialog.cancel") }}</v-btn>
        <v-btn
          v-if="showAdvanced"
          :disabled="!canSubmit"
          :loading="loading"
          color="primary"
          data-testid="submit-form-login"
          prepend-icon="mdi-login"
          @click="submit"
        >
          {{ t("SetSite.login.submit") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TSiteID } from "@ptd/site";

import {
  finishInteractiveSiteLogin,
  getCaptchaImage,
  loginSite,
  openInteractiveSiteLogin,
  prepareSiteLogin,
  reportCaptchaImageRenderFailure,
  type PreparedSiteLogin,
} from "@/options/service/siteLogin.ts";

const showDialog = defineModel<boolean>({ default: false });
const props = defineProps<{
  siteId: TSiteID;
  siteUrl?: string;
  schema?: string;
}>();

const { t } = useI18n();
const username = ref("");
const password = ref("");
const loginPath = ref("");
const remember = ref(true);
const showPassword = ref(false);
const loading = ref(false);
const errorMessage = ref("");
const successMessage = ref("");
const noticeMessage = ref("");
const captcha = ref("");
const captchaImageUrl = ref<string>();
const preparedLogin = shallowRef<PreparedSiteLogin>();
const browserLoginOpened = ref(false);
const canSubmit = computed(() => !!props.siteUrl && !!username.value && !!password.value && !loading.value);

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
  successMessage.value = "";
  try {
    await openInteractiveSiteLogin({
      siteUrl: props.siteUrl,
      schema: props.schema,
      loginPath: loginPath.value,
    });
    browserLoginOpened.value = true;
    noticeMessage.value = t("SetSite.login.browserOpened");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function finishBrowserLogin() {
  if (!props.siteUrl) return;
  loading.value = true;
  errorMessage.value = "";
  successMessage.value = "";
  try {
    const result = await finishInteractiveSiteLogin({
      siteId: props.siteId,
      siteUrl: props.siteUrl,
      schema: props.schema,
      loginPath: loginPath.value,
    });
    browserLoginOpened.value = false;
    noticeMessage.value = "";
    successMessage.value = t("SetSite.login.success", { count: result.cookieCount });
  } catch (error) {
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
    successMessage.value = "";
    noticeMessage.value = "";
    browserLoginOpened.value = false;
    return;
  }
});

watch(loginPath, clearPreparedLogin);
onBeforeUnmount(clearSensitiveState);

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
  successMessage.value = "";
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
    successMessage.value = t("SetSite.login.success", { count: result.cookieCount });
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
  <v-dialog v-model="showDialog" max-width="560">
    <v-card>
      <v-card-title>{{ t("SetSite.login.title") }}</v-card-title>
      <v-card-text>
        <v-alert class="mb-4" density="compact" type="info" variant="tonal">
          {{ t("SetSite.login.notice") }}
        </v-alert>
        <v-text-field
          v-model="loginPath"
          :hint="t('SetSite.login.loginPathHint')"
          :label="t('SetSite.login.loginPath')"
          persistent-hint
        />
        <v-btn
          block
          color="primary"
          data-testid="open-browser-login"
          prepend-icon="mdi-open-in-new"
          variant="flat"
          :loading="loading"
          @click="openBrowserLogin"
        >
          {{ t("SetSite.login.openBrowser") }}
        </v-btn>
        <v-btn
          v-if="browserLoginOpened"
          block
          class="mt-2"
          color="success"
          data-testid="finish-browser-login"
          prepend-icon="mdi-cookie-check"
          variant="outlined"
          :loading="loading"
          @click="finishBrowserLogin"
        >
          {{ t("SetSite.login.finishBrowser") }}
        </v-btn>
        <v-divider class="my-5" />
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
        <v-alert v-if="errorMessage" class="mt-4" density="compact" type="error" variant="tonal">
          {{ errorMessage }}
        </v-alert>
        <v-alert v-if="noticeMessage" class="mt-4" density="compact" type="warning" variant="tonal">
          {{ noticeMessage }}
        </v-alert>
        <v-alert v-if="successMessage" class="mt-4" density="compact" type="success" variant="tonal">
          {{ successMessage }}
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="loading" variant="text" @click="showDialog = false">{{ t("common.dialog.cancel") }}</v-btn>
        <v-btn
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

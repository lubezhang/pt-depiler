// Generated from Rust DTOs and command signatures. Run PTD_UPDATE_IPC_TYPES=1 cargo test ap_01_generated_contract_is_current to update.

export type AppErrorCode = "APP_BOOTSTRAP_FAILED" | "COMMAND_HANDLER_MISSING" | "COMMAND_SERIALIZATION_INVALID" | "INFRASTRUCTURE_FAILURE" | "VALIDATION_FAILED" | "STORAGE_CONFLICT" | "STORAGE_UNAVAILABLE" | "STORAGE_RECOVERY_REQUIRED" | "STORAGE_COMMIT_UNCERTAIN" | "HTTP_POLICY_REJECTED" | "HTTP_RESPONSE_TOO_LARGE" | "HTTP_REQUEST_CANCELLED" | "HTTP_TIMEOUT" | "FILE_DOWNLOAD_FAILED" | "IPC_INVALID_INPUT";
export type AppErrorDto = { code: AppErrorCode, message: string, operationId: string | null, resourceId: string | null, taskId: string | null, };
export type FetchBody = { "kind": "none" } | { "kind": "text", "data": string } | { "kind": "base64", "data": string };
export type FetchRequest = { requestId?: string, siteId: string, url: string, method?: string, headers?: { [key: string]: string }, body: FetchBody, params?: { [key: string]: string }, 
/**
 * 单次请求超时（毫秒），默认 30s
 */
timeout?: number, 
/**
 * Cloudflare 拦截重试次数，默认 3
 */
maxRetries?: number, 
/**
 * 是否以二进制方式返回 body（base64 编码），用于种子文件等
 */
binary?: boolean, 
/**
 * Axios-compatible redirect limit. `0` preserves the original response,
 * which is required by sites that put a torrent body on a 302 response.
 */
maxRedirects?: number, };
export type FetchResponse = { status: number, headers: { [key: string]: string }, body: string, finalUrl: string, };
export type CookieInfo = { name: string, value: string, domain: string, hostOnly: boolean, path: string, secure: boolean, httpOnly: boolean, expirationDate: number | null, sameSite: string | null, };
export type DownloadRequest = { url: string, headers: { [key: string]: string } | null, savePath: string, timeout?: number, };

export interface IpcCommandMap {
  ping: { input: Record<string, never>; output: string };
  ptd_fetch: { input: { req: FetchRequest }; output: FetchResponse };
  ptd_cancel_fetch: { input: { requestId: string }; output: void };
  open_site_login: { input: { siteUrl: string; loginUrl: string }; output: void };
  finish_site_login: { input: { siteUrl: string }; output: number };
  get_cookies: { input: { domain?: string | null }; output: Array<CookieInfo> };
  set_cookie: { input: { cookie: CookieInfo }; output: void };
  get_ext_storage: { input: { key: string }; output: unknown };
  set_ext_storage: { input: { key: string; value: unknown }; output: void };
  merge_ext_storage: { input: { key: string; base: unknown; value: unknown }; output: unknown };
  merge_ext_storage_batch: { input: { base: unknown; value: unknown }; output: unknown };
  get_storage_status: { input: Record<string, never>; output: unknown };
  get_cache_snapshot: { input: Record<string, never>; output: unknown };
  get_backup_snapshot: { input: { includeCookies: boolean }; output: unknown };
  restore_backup_snapshot: { input: { expectedRevision: number; data: unknown; cookies?: Array<CookieInfo> | null }; output: string };
  recover_backup_restore: { input: Record<string, never>; output: void };
  import_legacy_restore_journals: { input: { journals: Array<unknown>; histories: Array<unknown> }; output: void };
  reconcile_storage_commit: { input: Record<string, never>; output: boolean };
  import_download_history: { input: { histories: Array<unknown> }; output: boolean };
  list_download_history: { input: Record<string, never>; output: Array<unknown> };
  get_download_history: { input: { id: number }; output: unknown | null };
  insert_download_history: { input: { history: unknown }; output: number };
  save_download_history_if_unchanged: { input: { id: number; base: unknown; history: unknown }; output: boolean };
  delete_download_history: { input: { id: number }; output: boolean };
  clear_download_history: { input: Record<string, never>; output: number };
  replace_download_history: { input: { histories: Array<unknown> }; output: void };
  download_to_local: { input: { req: DownloadRequest }; output: string };
  schedule_redownload: { input: { downloadId: string; delaySecs: number }; output: void };
  ensure_periodic_tasks: { input: Record<string, never>; output: void };
  claim_due_task: { input: { owner: string }; output: unknown | null };
  renew_task: { input: { taskId: string; owner: string }; output: boolean };
  finish_task: { input: { taskId: string; owner: string; outcome: string }; output: void };
  release_tasks: { input: { owner: string }; output: void };
  list_task_status: { input: Record<string, never>; output: Array<unknown> };
  request_task_cancel: { input: { taskId: string }; output: boolean };
  resolve_task: { input: { taskId: string; action: string }; output: void };
}

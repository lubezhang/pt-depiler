import axios, {
  AxiosError,
  AxiosHeaders,
  CanceledError,
  type AxiosBasicCredentials,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";

export type FetchBody = { kind: "none" } | { kind: "text"; data: string } | { kind: "base64"; data: string };

export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
}

export function toAxiosTransportError(error: unknown, config: InternalAxiosRequestConfig): AxiosError {
  const message = String(error);
  if (message.includes("请求已取消")) {
    return new CanceledError(message, config);
  }
  const code = message.includes("请求超时") ? AxiosError.ECONNABORTED : AxiosError.ERR_NETWORK;
  return new AxiosError(message, code, config);
}

export async function withCancellation<T>(
  request: Promise<T>,
  config: InternalAxiosRequestConfig,
  onCancellation?: () => void | Promise<void>,
): Promise<T> {
  let cancellationNotified = false;
  const notifyCancellation = () => {
    if (cancellationNotified) return;
    cancellationNotified = true;
    try {
      void Promise.resolve(onCancellation?.()).catch(() => undefined);
    } catch {
      // Cancellation must retain Axios semantics even if backend notification fails synchronously.
    }
  };

  try {
    config.cancelToken?.throwIfRequested();
  } catch (error) {
    notifyCancellation();
    throw error;
  }
  if (config.signal?.aborted) {
    notifyCancellation();
    throw new CanceledError(undefined, config);
  }
  if (!config.signal && !config.cancelToken) {
    return await request;
  }

  const asCanceledError = (reason?: unknown) =>
    reason instanceof CanceledError ? reason : new CanceledError(undefined, config);
  let rejectCancellation: (reason?: unknown) => void = () => undefined;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = (reason?: unknown) => reject(asCanceledError(reason));
  });
  const onAbort = () => {
    notifyCancellation();
    rejectCancellation();
  };
  const onCancel = (reason?: unknown) => {
    notifyCancellation();
    rejectCancellation(reason);
  };
  config.signal?.addEventListener?.("abort", onAbort, { once: true });
  config.cancelToken?.subscribe(onCancel);

  try {
    return await Promise.race([request, cancellation]);
  } finally {
    config.signal?.removeEventListener?.("abort", onAbort);
    config.cancelToken?.unsubscribe(onCancel);
  }
}

export function buildRequestUrl(config: InternalAxiosRequestConfig): string {
  return axios.getUri(config);
}

export function resolveSiteId(url: string, hostMap: Record<string, string>): string {
  try {
    return hostMap[new URL(url).host] ?? "default";
  } catch {
    return "default";
  }
}

export function headersToRecord(
  headers: InternalAxiosRequestConfig["headers"],
  auth?: AxiosBasicCredentials,
): Record<string, string> {
  const result = AxiosHeaders.from(headers).toJSON(true) as Record<string, string>;
  if (auth) {
    result.Authorization = `Basic ${bytesToBase64(new TextEncoder().encode(`${auth.username}:${auth.password}`))}`;
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
}

function setContentType(headers: Record<string, string>, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "content-type") {
      delete headers[key];
    }
  }
  headers["content-type"] = value;
}

function escapeMultipartHeader(value: string): string {
  return value.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }

  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取 Blob 请求体"));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function encodeMultipartFormData(data: FormData): Promise<{ bytes: Uint8Array; contentType: string }> {
  const boundary = `----pt-depiler-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const [name, value] of data.entries()) {
    parts.push(encoder.encode(`--${boundary}\r\n`));
    if (typeof value === "string") {
      parts.push(
        encoder.encode(`Content-Disposition: form-data; name="${escapeMultipartHeader(name)}"\r\n\r\n${value}\r\n`),
      );
      continue;
    }

    parts.push(
      encoder.encode(
        `Content-Disposition: form-data; name="${escapeMultipartHeader(name)}"; filename="${escapeMultipartHeader(value.name)}"\r\n` +
          `Content-Type: ${value.type || "application/octet-stream"}\r\n\r\n`,
      ),
      await blobToBytes(value),
      encoder.encode("\r\n"),
    );
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  return { bytes: joinBytes(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function serializeRequestBody(
  data: unknown,
  headers: Record<string, string>,
): Promise<{ body: FetchBody; headers: Record<string, string> }> {
  if (data === null || typeof data === "undefined") {
    return { body: { kind: "none" }, headers };
  }

  if (typeof FormData !== "undefined" && data instanceof FormData) {
    const encoded = await encodeMultipartFormData(data);
    const nextHeaders = { ...headers };
    setContentType(nextHeaders, encoded.contentType);
    return {
      body: { kind: "base64", data: bytesToBase64(encoded.bytes) },
      headers: nextHeaders,
    };
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    const nextHeaders = { ...headers };
    if (data.type && !hasContentType(nextHeaders)) {
      nextHeaders["content-type"] = data.type;
    }
    return {
      body: { kind: "base64", data: arrayBufferToBase64(await data.arrayBuffer()) },
      headers: nextHeaders,
    };
  }

  if (data instanceof ArrayBuffer) {
    return { body: { kind: "base64", data: arrayBufferToBase64(data) }, headers };
  }

  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return { body: { kind: "base64", data: bytesToBase64(bytes) }, headers };
  }

  if (typeof data === "string") {
    return { body: { kind: "text", data }, headers };
  }

  if (data instanceof URLSearchParams) {
    return { body: { kind: "text", data: data.toString() }, headers };
  }

  return { body: { kind: "text", data: JSON.stringify(data) }, headers };
}

export function isBinaryResponseType(responseType?: string): boolean {
  return responseType === "arraybuffer" || responseType === "blob";
}

function base64ToBytes(body: string): Uint8Array<ArrayBuffer> {
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function decodeResponseBody(body: string, responseType?: string, contentType?: string): unknown {
  if (responseType === "arraybuffer" || responseType === "blob") {
    const bytes = base64ToBytes(body);
    if (responseType === "blob") {
      return new Blob([bytes], contentType ? { type: contentType } : undefined);
    }
    return bytes.buffer;
  }

  switch (responseType) {
    case "json":
      try {
        return body === "" ? undefined : JSON.parse(body);
      } catch {
        return body;
      }
    case "document":
      return new DOMParser().parseFromString(body, "text/html");
    default:
      return body;
  }
}

export function createAxiosResponse(payload: FetchResponse, config: InternalAxiosRequestConfig): AxiosResponse {
  const headers = AxiosHeaders.from(payload.headers);
  const data = decodeResponseBody(payload.body, config.responseType, headers.get("content-type")?.toString());
  const request = {
    responseURL: payload.finalUrl,
    responseText: typeof data === "string" ? data : undefined,
    responseType: config.responseType,
    responseXML: config.responseType === "document" && data instanceof Document ? data : undefined,
  };
  const response: AxiosResponse = {
    data,
    status: payload.status,
    statusText: "",
    headers,
    config,
    request,
  };

  const validateStatus = config.validateStatus;
  if (!validateStatus || validateStatus(payload.status)) {
    return response;
  }

  const code = payload.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST;
  throw new AxiosError(`Request failed with status code ${payload.status}`, code, config, request, response);
}

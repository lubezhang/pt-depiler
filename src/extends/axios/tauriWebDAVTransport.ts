import axios from "axios";
import { getPatcher } from "webdav";

import { tauriAdapter } from "./tauriAdapter.ts";

function mergeHeaders(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return Object.fromEntries(headers.entries());
}

async function resolveBody(input: RequestInfo | URL, init?: RequestInit): Promise<BodyInit | ArrayBuffer | undefined> {
  if (init?.body != null) return init.body;
  if (!(input instanceof Request) || input.method === "GET" || input.method === "HEAD") return undefined;
  return await input.clone().arrayBuffer();
}

function responseHeaders(headers: unknown): Headers {
  const result = new Headers();
  if (!headers || typeof headers !== "object") return result;

  for (const [name, rawValue] of Object.entries(headers)) {
    if (rawValue == null) continue;
    result.set(name, Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue));
  }
  return result;
}

/**
 * webdav-client keeps its DAV parsing and Digest state machine, while this fetch
 * implementation sends the actual HTTP request through the Tauri IPC adapter.
 */
export async function tauriWebDAVFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : input.toString();
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const response = await axios.request<ArrayBuffer>({
    adapter: tauriAdapter,
    data: await resolveBody(input, init),
    headers: mergeHeaders(input, init),
    method,
    responseType: "arraybuffer",
    signal,
    url,
    validateStatus: () => true,
  });

  const finalUrl = (response.request as { responseURL?: string } | undefined)?.responseURL ?? url;
  const body = [204, 205, 304].includes(response.status) ? null : response.data;
  const webResponse = new Response(body, {
    headers: responseHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
  });

  Object.defineProperties(webResponse, {
    redirected: { configurable: true, value: finalUrl !== url },
    url: { configurable: true, value: finalUrl },
  });
  return webResponse;
}

let installed = false;

export function installTauriWebDAVTransport(): void {
  if (installed) return;
  getPatcher().patch("fetch", (...args: unknown[]) =>
    tauriWebDAVFetch(args[0] as RequestInfo | URL, args[1] as RequestInit | undefined),
  );
  installed = true;
}

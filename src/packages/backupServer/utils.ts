import JSZip from "jszip";
import CryptoJS from "crypto-js";
import { EListOrderBy, EListOrderMode } from "./type";
import type { IBackupData, IBackupFileInfo, IBackupFileListOption, IBackupFileManifest } from "./type";

export const BACKUP_FORMAT_VERSION = 2;
export const MAX_BACKUP_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_FILES = 32;

/**
 * 注意，我们不直接使用用户提供的 secretKey 作为 AES 的密钥，因为可能无法提供足够强度的密钥
 */
export function encryptData(data: any, encryptionKey?: string): string {
  const stringifyData = JSON.stringify(data);
  if (!encryptionKey) {
    return stringifyData;
  }
  const the_key = CryptoJS.MD5(encryptionKey).toString().substring(0, 16);
  return CryptoJS.AES.encrypt(stringifyData, the_key).toString();
}

export function decryptData<T = any>(data: string, encryptionKey?: string): T {
  if (!encryptionKey) {
    return JSON.parse(data);
  }
  const the_key = CryptoJS.MD5(encryptionKey).toString().substring(0, 16);
  const decrypted = CryptoJS.AES.decrypt(data, the_key).toString(CryptoJS.enc.Utf8);
  return JSON.parse(decrypted) as T;
}

const domains = new Set([
  "config",
  "metadata",
  "userInfo",
  "downloadHistory",
  "searchResultSnapshot",
  "keepUploadTask",
  "cookies",
]);
const iterations = 210_000;
const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  return CryptoJS.enc.Base64.stringify(CryptoJS.lib.WordArray.create(bytes));
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("BACKUP_INVALID_ENCRYPTION");
  const words = CryptoJS.enc.Base64.parse(value);
  return Uint8Array.from({ length: words.sigBytes }, (_, i) => (words.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255);
}

async function archiveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function authenticatedHeader(manifest: IBackupFileManifest, domain: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify({
      formatVersion: manifest.formatVersion,
      dataFormatVersion: manifest.dataFormatVersion,
      encryption: manifest.encryption,
      time: manifest.time,
      version: manifest.version,
      redactedSecrets: manifest.redactedSecrets,
      domains: manifest.domains,
      crypto: manifest.crypto,
      domain,
    }),
  );
}

// Count decoded chunks as well as the ZIP directory size before allocating text.
async function boundedContent(file: JSZip.JSZipObject, limit: number): Promise<string> {
  const declared = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (declared !== undefined && declared > limit) throw new Error("BACKUP_FILE_TOO_LARGE");
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Uint8Array[] = [];
    const stream = (file as unknown as { internalStream(type: string): any }).internalStream("uint8array");
    stream
      .on("data", (chunk: Uint8Array) => {
        size += chunk.byteLength;
        if (size > limit) {
          stream.pause();
          reject(new Error("BACKUP_FILE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", reject)
      .on("end", () => {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          resolve(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          reject(new Error("BACKUP_INVALID_UTF8"));
        }
      })
      .resume();
  });
}

export async function backupDataToJSZipBlob(data: IBackupData, encryptionKey?: string): Promise<Blob> {
  const zip = new JSZip();
  const source = structuredClone(data);
  const encrypted = Boolean(encryptionKey);
  const manifest = {
    ...(source.manifest ?? {}),
    formatVersion: BACKUP_FORMAT_VERSION,
    dataFormatVersion: 1,
    encryption: encrypted,
    time: Date.now(),
    files: {},
  } as IBackupFileManifest;
  delete source.manifest;
  manifest.domains = Object.keys(source);
  if (manifest.domains.length > MAX_BACKUP_FILES || manifest.domains.some((domain: string) => !domains.has(domain))) {
    throw new Error("BACKUP_INVALID_DOMAIN");
  }
  let key: CryptoKey | undefined;
  if (encrypted) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    manifest.crypto = { algorithm: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iterations, salt: base64(salt) };
    key = await archiveKey(encryptionKey!, salt);
  } else {
    delete manifest.crypto;
  }
  let total = 0;
  for (const [domain, value] of Object.entries(source)) {
    let content = JSON.stringify(value);
    if (encoder.encode(content).byteLength > MAX_BACKUP_FILE_BYTES) throw new Error("BACKUP_FILE_TOO_LARGE");
    if (key) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: authenticatedHeader(manifest, domain) },
        key,
        encoder.encode(content),
      );
      content = JSON.stringify({ nonce: base64(nonce), ciphertext: base64(new Uint8Array(ciphertext)) });
    }
    const size = encoder.encode(content).byteLength;
    total += size;
    if (size > MAX_BACKUP_FILE_BYTES || total > MAX_BACKUP_ARCHIVE_BYTES) throw new Error("BACKUP_FILE_TOO_LARGE");
    const name = `${domain}.json`;
    zip.file(name, content);
    manifest.files[domain] = { name, hash: CryptoJS.SHA256(content).toString(), size };
  }
  zip.file("manifest.json", JSON.stringify(manifest));
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } });
  if (blob.size > MAX_BACKUP_ARCHIVE_BYTES) throw new Error("BACKUP_ARCHIVE_TOO_LARGE");
  return blob;
}

export async function jsZipBlobToBackupData(blob: Blob, encryptionKey?: string): Promise<IBackupData> {
  if (blob.size > MAX_BACKUP_ARCHIVE_BYTES) throw new Error("BACKUP_ARCHIVE_TOO_LARGE");
  const zip = await JSZip.loadAsync(typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : blob);
  if (Object.keys(zip.files).length > MAX_BACKUP_FILES + 1) throw new Error("BACKUP_TOO_MANY_FILES");
  if (
    Object.entries(zip.files).some(
      ([name, file]) =>
        file.dir ||
        /[/\\]/.test(name) ||
        ((file as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? name) !== name,
    )
  )
    throw new Error("BACKUP_INVALID_PATH");
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("Unsupported or missing backup manifest");
  const manifest = JSON.parse(await boundedContent(manifestFile, 64 * 1024)) as IBackupFileManifest;
  const format = manifest?.formatVersion ?? 1;
  if (
    ![1, 2].includes(format) ||
    !manifest?.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    typeof manifest.encryption !== "boolean"
  )
    throw new Error("Unsupported or missing backup manifest");
  const entries = Object.entries(manifest.files).filter(([key]) => key !== "manifest");
  if (entries.length > MAX_BACKUP_FILES) throw new Error("BACKUP_TOO_MANY_FILES");
  if (
    format === 2 &&
    (manifest.dataFormatVersion !== 1 ||
      !Array.isArray(manifest.domains) ||
      JSON.stringify(manifest.domains) !== JSON.stringify(entries.map(([domain]) => domain)))
  )
    throw new Error("BACKUP_INVALID_DATA_FORMAT");
  let key: CryptoKey | undefined;
  if (format === 2 && manifest.encryption) {
    const parameters = manifest.crypto;
    if (
      !encryptionKey ||
      parameters?.algorithm !== "AES-256-GCM" ||
      parameters.kdf !== "PBKDF2-SHA-256" ||
      parameters.iterations !== iterations
    )
      throw new Error("BACKUP_INVALID_ENCRYPTION");
    const salt = fromBase64(parameters.salt);
    if (salt.length !== 16) throw new Error("BACKUP_INVALID_ENCRYPTION");
    key = await archiveKey(encryptionKey, salt);
  }
  const data: IBackupData = {};
  let total = 0;
  const filenames = new Set(["manifest.json"]);
  for (const [domain, entry] of entries) {
    if (!domains.has(domain) || !entry || entry.name !== `${domain}.json` || filenames.has(entry.name))
      throw new Error("BACKUP_INVALID_DOMAIN");
    filenames.add(entry.name);
    const file = zip.file(entry.name);
    if (!file) throw new Error(`Missing backup file: ${entry.name}`);
    const content = await boundedContent(file, MAX_BACKUP_FILE_BYTES);
    const size = encoder.encode(content).byteLength;
    total += size;
    if (total > MAX_BACKUP_ARCHIVE_BYTES) throw new Error("BACKUP_ARCHIVE_TOO_LARGE");
    if (format === 2 && entry.size !== size) throw new Error("BACKUP_SIZE_MISMATCH");
    const hash = format === 2 ? CryptoJS.SHA256(content) : CryptoJS.MD5(content);
    if (hash.toString() !== entry.hash) throw new Error(`File hash mismatch for ${entry.name}.`);
    try {
      if (key) {
        const envelope = JSON.parse(content);
        const nonce = fromBase64(envelope.nonce);
        if (nonce.length !== 12) throw new Error("BACKUP_INVALID_ENCRYPTION");
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce, additionalData: authenticatedHeader(manifest, domain) },
          key,
          fromBase64(envelope.ciphertext),
        );
        data[domain] = JSON.parse(new TextDecoder().decode(plaintext));
      } else {
        data[domain] = decryptData(content, manifest.encryption ? encryptionKey : undefined);
      }
    } catch {
      throw new Error(`Failed to decrypt file: ${entry.name}`);
    }
  }
  if (format === 2 && Object.keys(zip.files).some((name) => !filenames.has(name)))
    throw new Error("BACKUP_UNDECLARED_FILE");
  data.manifest = manifest;
  return data;
}

export function localSort(files: IBackupFileInfo[], options: IBackupFileListOption): IBackupFileInfo[] {
  if (files.length > 0 && Object.keys(options).length > 0) {
    const orderMode: EListOrderMode = options.orderMode ?? EListOrderMode.desc;
    const orderBy: EListOrderBy = options.orderBy ?? EListOrderBy.time;

    files.sort((a, b) => {
      let v1, v2;
      switch (orderBy) {
        case EListOrderBy.name:
          v1 = a.filename;
          v2 = b.filename;
          break;
        case EListOrderBy.size:
          v1 = a.size;
          v2 = b.size;
          break;

        case EListOrderBy.time:
        default:
          v1 = a.time;
          v2 = b.time;
          break;
      }

      const compareRep = v1.toString().localeCompare(v2.toString());
      return orderMode === EListOrderMode.desc ? -compareRep : compareRep;
    });
  }

  return files;
}

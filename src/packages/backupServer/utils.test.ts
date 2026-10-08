// @vitest-environment node
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { BACKUP_FORMAT_VERSION, jsZipBlobToBackupData, backupDataToJSZipBlob } from "./utils.ts";

describe("backup archive format", () => {
  it("writes a versioned archive without mutating the input", async () => {
    const input = { manifest: { version: "test" }, config: { theme: "dark" } };
    const before = structuredClone(input);
    const blob = await backupDataToJSZipBlob(input);
    expect(input).toEqual(before);
    const restored = await jsZipBlobToBackupData(blob);
    expect(restored.config).toEqual(input.config);
    expect(restored.manifest?.formatVersion).toBe(BACKUP_FORMAT_VERSION);
  });

  it("rejects tampered file content before returning data", async () => {
    const blob = await backupDataToJSZipBlob({ config: { theme: "dark" } });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const content = JSON.stringify({ theme: "tampered" });
    zip.file("config.json", content);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    manifest.files.config.size = new TextEncoder().encode(content).byteLength;
    zip.file("manifest.json", JSON.stringify(manifest));
    const tampered = await zip.generateAsync({ type: "blob" });
    await expect(jsZipBlobToBackupData(tampered)).rejects.toThrow("File hash mismatch");
  });

  it("rejects archives with unsupported manifest versions", async () => {
    const blob = await backupDataToJSZipBlob({ config: { theme: "dark" } });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    manifest.formatVersion = BACKUP_FORMAT_VERSION + 1;
    zip.file("manifest.json", JSON.stringify(manifest));
    const future = await zip.generateAsync({ type: "blob" });
    await expect(jsZipBlobToBackupData(future)).rejects.toThrow("Unsupported or missing backup manifest");
  });
});

it("round trips AES-GCM archives and rejects wrong passwords and modified authenticated headers", async () => {
  const input = { config: { theme: "dark", secret: "fixture-only" }, manifest: { redactedSecrets: false } };
  const blob = await backupDataToJSZipBlob(input, "password");
  expect((await jsZipBlobToBackupData(blob, "password")).config).toEqual(input.config);
  await expect(jsZipBlobToBackupData(blob, "wrong-password")).rejects.toThrow("Failed to decrypt");
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  manifest.redactedSecrets = true;
  zip.file("manifest.json", JSON.stringify(manifest));
  const changed = await zip.generateAsync({ type: "blob" });
  await expect(jsZipBlobToBackupData(changed, "password")).rejects.toThrow("Failed to decrypt");
});

it("imports unversioned legacy MD5 ZIPs with their original encryption format", async () => {
  const { default: CryptoJS } = await import("crypto-js");
  const { encryptData } = await import("./utils.ts");
  for (const encryptionKey of [undefined, "legacy-password"]) {
    const zip = new JSZip();
    const content = encryptData({ theme: "dark" }, encryptionKey);
    zip.file("config.json", content);
    zip.file(
      "manifest.json",
      JSON.stringify({
        encryption: Boolean(encryptionKey),
        files: {
          config: { name: "config.json", hash: CryptoJS.MD5(content).toString() },
        },
      }),
    );
    const blob = await zip.generateAsync({ type: "blob" });
    expect((await jsZipBlobToBackupData(blob, encryptionKey)).config).toEqual({ theme: "dark" });
  }
});

it("rejects unsafe original ZIP paths even when JSZip normalizes them to declared filenames", async () => {
  const blob = await backupDataToJSZipBlob({ config: { theme: "dark" } });
  const original = await JSZip.loadAsync(await blob.arrayBuffer());
  const malicious = new JSZip();
  malicious.file("manifest.json", await original.file("manifest.json")!.async("string"));
  malicious.file("../config.json", await original.file("config.json")!.async("string"), { createFolders: false });
  await expect(jsZipBlobToBackupData(await malicious.generateAsync({ type: "blob" }))).rejects.toThrow(
    "BACKUP_INVALID_PATH",
  );
});

it("rejects missing files, wrong sizes, undeclared domains and oversized decompression", async () => {
  const { MAX_BACKUP_FILE_BYTES } = await import("./utils.ts");
  const blob = await backupDataToJSZipBlob({ config: { theme: "dark" } });
  for (const mutate of [
    (zip: JSZip, _manifest: any) => zip.remove("config.json"),
    (_zip: JSZip, manifest: any) => {
      manifest.files.config.size++;
    },
    (zip: JSZip, _manifest: any) => zip.file("extra.json", "{}"),
    (_zip: JSZip, manifest: any) => {
      manifest.files.config.name = "../config.json";
    },
  ]) {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    mutate(zip, manifest);
    zip.file("manifest.json", JSON.stringify(manifest));
    await expect(jsZipBlobToBackupData(await zip.generateAsync({ type: "blob" }))).rejects.toThrow();
  }
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  zip.file("config.json", "x".repeat(MAX_BACKUP_FILE_BYTES + 1));
  await expect(
    jsZipBlobToBackupData(await zip.generateAsync({ type: "blob", compression: "DEFLATE" })),
  ).rejects.toThrow("BACKUP_FILE_TOO_LARGE");
});

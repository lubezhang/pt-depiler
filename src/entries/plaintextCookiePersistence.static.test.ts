import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rustRoot = resolve(process.cwd(), "src-tauri");
const stateSource = readFileSync(resolve(rustRoot, "src/state.rs"), "utf8");
const cargoToml = readFileSync(resolve(rustRoot, "Cargo.toml"), "utf8");

describe("本地 Cookie 明文持久化", () => {
  it("不使用 Keychain 或 AES 密钥", () => {
    // Cookie persistence remains a standalone JSON store. Other domains may
    // legitimately use the OS keyring for credentials.
    expect(stateSource).not.toContain("keyring::");
    expect(stateSource).not.toContain("keyring::");
    expect(stateSource).not.toContain("Aes256Gcm");
    expect(stateSource).not.toContain("PTD_E2E_COOKIE_KEY_BASE64");
  });

  it("使用独立的明文 JSON 文件", () => {
    expect(stateSource).toContain('const COOKIE_FILE_NAME: &str = "cookies.v2.json";');
    expect(stateSource).toContain("save_incl_expired_and_nonpersistent");
    expect(stateSource).toContain("cookie_store::serde::json::load");
  });
});

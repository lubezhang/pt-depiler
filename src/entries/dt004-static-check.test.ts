import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rustRoot = resolve(process.cwd(), "src-tauri");

describe("DT-004 未使用桌面插件防回归", () => {
  it("只保留仍在使用的 store 与 dialog 插件", () => {
    const cargoToml = readFileSync(resolve(rustRoot, "Cargo.toml"), "utf8");
    const appSource = readFileSync(resolve(rustRoot, "src/lib.rs"), "utf8");
    const capability = readFileSync(resolve(rustRoot, "capabilities/default.json"), "utf8");

    for (const source of [cargoToml, appSource, capability]) {
      expect(source).not.toMatch(/(?:tauri[-_]plugin[-_])?(?:notification|global[-_]shortcut)/i);
    }

    expect(cargoToml).toContain("tauri-plugin-store");
    expect(cargoToml).toContain("tauri-plugin-dialog");
    expect(appSource).toContain("tauri_plugin_store");
    expect(appSource).toContain("tauri_plugin_dialog");
    expect(capability).toContain('"store:default"');
    expect(capability).toContain('"dialog:default"');
    expect(existsSync(resolve(rustRoot, "src/notification.rs"))).toBe(false);
  });
});

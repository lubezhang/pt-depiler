import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(process.cwd(), "src/entries/options/App.vue"), "utf8");

describe("桌面端页面缩放提示", () => {
  it("不会根据 devicePixelRatio 显示缩放提示", () => {
    expect(appSource).not.toContain("useDevicePixelRatio");
    expect(appSource).not.toContain("wrongPixelRatioNotice");
    expect(appSource).not.toContain("ignoreWrongPixelRatio");
  });
});

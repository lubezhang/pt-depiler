import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const criticalFiles = [
  "src/entries/options/service/index.ts",
  "src/entries/options/service/startup.ts",
  "src/entries/background/utils/alarms.ts",
  "src/entries/background/utils/fixer.ts",
  "src/entries/background/utils/cookies.ts",
  "src/entries/offscreen/utils/download.ts",
  "src/entries/offscreen/utils/backup.ts",
  "src/entries/storage.ts",
];

describe("DT-003 关键路径静默失败防回归", () => {
  it("不包含空 catch 或裸 Promise.catch", () => {
    const violations = criticalFiles.flatMap((file) => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const matches = source.match(/\.catch\s*\(\s*\)|catch(?:\s*\([^)]*\))?\s*\{\s*\}/g) ?? [];
      return matches.map((match) => `${file}: ${match}`);
    });

    expect(violations).toEqual([]);
  });
});

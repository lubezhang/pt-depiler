import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findArchitectureViolations } from "../../scripts/check-architecture-boundaries.ts";

const temporaryRoots: string[] = [];

function createFixture(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), "pt-depiler-dt006-"));
  temporaryRoots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = resolve(root, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("DT-006 架构边界门禁", () => {
  it("当前代码仅保留登记的临时例外", () => {
    expect(findArchitectureViolations()).toEqual([]);
  });

  it("拒绝领域层反向依赖与浏览器扩展入口", () => {
    const root = createFixture({
      "manifest.json": "{}",
      "src/domain/use-case.ts": 'import { ref } from "vue";\nvoid ref;\n',
    });

    expect(findArchitectureViolations(root).map((violation) => violation.rule)).toEqual(
      expect.arrayContaining(["browser-extension-entrypoint", "domain-dependency"]),
    );
  });

  it("拒绝应用层直接导入 entries", () => {
    const root = createFixture({
      "src/application/search/query.ts": 'import { sendMessage } from "@/messages.ts";\nvoid sendMessage;\n',
    });

    expect(findArchitectureViolations(root).map((violation) => violation.rule)).toContain("application-dependency");
  });

  it("拒绝新增空 catch、副作用导入和全局 patch", () => {
    const root = createFixture({
      "src/entries/new-entry.ts": [
        'import "./register.ts";',
        "try {",
        "  run();",
        "} catch {}",
        "axios.defaults.adapter = adapter;",
      ].join("\n"),
    });

    expect(findArchitectureViolations(root).map((violation) => violation.rule)).toEqual(
      expect.arrayContaining(["empty-catch", "global-patch", "side-effect-import"]),
    );
  });
});

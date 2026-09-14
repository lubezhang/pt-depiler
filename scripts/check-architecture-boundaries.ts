import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";

import {
  emptyCatchAllowances,
  globalPatchAllowances,
  packageEntryImportAllowances,
  sideEffectImportAllowances,
} from "./architecture-boundaries.ts";

export interface ArchitectureViolation {
  file: string;
  line: number;
  message: string;
  rule: string;
}

const sourceExtensions = new Set([".ts", ".tsx", ".vue"]);
const ignoredDirectories = new Set([".codegraph", ".git", "dist", "node_modules", "target"]);

function toProjectPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function walkFiles(directory: string, files: string[] = []): string[] {
  if (!existsSync(directory)) return files;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) walkFiles(resolve(directory, entry.name), files);
      continue;
    }
    files.push(resolve(directory, entry.name));
  }
  return files;
}

function isSourceFile(file: string): boolean {
  return [...sourceExtensions].some((extension) => file.endsWith(extension)) && !file.includes(".test.");
}

function importSpecifiers(source: string): Array<{ index: number; specifier: string }> {
  const patterns = [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g];
  const imports: Array<{ index: number; specifier: string }> = [];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      imports.push({ index: match.index ?? 0, specifier: match[1] });
    }
  }
  return imports;
}

function isEntryImport(root: string, file: string, specifier: string): boolean {
  if (specifier.startsWith("@/")) return true;
  if (specifier.startsWith("~/entries/")) return true;
  if (!specifier.startsWith(".")) return false;
  return resolve(file, "..", specifier).startsWith(resolve(root, "src/entries"));
}

function validateExceptions(): ArchitectureViolation[] {
  const exceptions = [
    ...Object.values(emptyCatchAllowances),
    ...Object.values(packageEntryImportAllowances),
    ...Object.values(sideEffectImportAllowances),
    ...Object.values(globalPatchAllowances),
  ];
  return exceptions.flatMap((exception) => {
    if (exception.reason && /^DT-\d{3}$/.test(exception.removalTask)) return [];
    return [
      { file: "scripts/architecture-boundaries.ts", line: 1, message: "临时例外缺少删除任务", rule: "exception" },
    ];
  });
}

export function findArchitectureViolations(root = process.cwd()): ArchitectureViolation[] {
  const sourceRoot = resolve(root, "src");
  const files = walkFiles(sourceRoot).filter(isSourceFile);
  const violations = validateExceptions();

  for (const file of files) {
    const projectPath = toProjectPath(root, file);
    const source = readFileSync(file, "utf8");
    const imports = importSpecifiers(source);

    if (projectPath.startsWith("src/packages/domain/")) {
      for (const imported of imports) {
        const forbidden =
          imported.specifier === "vue" ||
          imported.specifier === "pinia" ||
          imported.specifier.startsWith("@tauri-apps/") ||
          isEntryImport(root, file, imported.specifier);
        if (forbidden) {
          violations.push({
            file: projectPath,
            line: lineAt(source, imported.index),
            message: `领域层不能导入 ${imported.specifier}`,
            rule: "domain-dependency",
          });
        }
      }
    }

    if (projectPath.startsWith("src/packages/")) {
      for (const imported of imports) {
        if (!isEntryImport(root, file, imported.specifier)) continue;
        const key = `${projectPath}:${imported.specifier}`;
        if (packageEntryImportAllowances[key]) continue;
        violations.push({
          file: projectPath,
          line: lineAt(source, imported.index),
          message: `packages 不能反向导入 entries：${imported.specifier}`,
          rule: "package-entry-dependency",
        });
      }
    }

    const emptyCatches = [...source.matchAll(/catch(?:\s*\([^)]*\))?\s*\{\s*\}/g)];
    const emptyCatchAllowance = emptyCatchAllowances[projectPath];
    if (!emptyCatchAllowance && emptyCatches.length > 0) {
      for (const emptyCatch of emptyCatches) {
        violations.push({
          file: projectPath,
          line: lineAt(source, emptyCatch.index ?? 0),
          message: "禁止空 catch",
          rule: "empty-catch",
        });
      }
    } else if (emptyCatchAllowance && emptyCatches.length > emptyCatchAllowance.maximum) {
      violations.push({
        file: projectPath,
        line: lineAt(source, emptyCatches[emptyCatchAllowance.maximum].index ?? 0),
        message: `空 catch 数量超过临时例外上限 ${emptyCatchAllowance.maximum}`,
        rule: "empty-catch",
      });
    }

    for (const imported of source.matchAll(/^\s*import\s*["']([^"']+)["'];?\s*$/gm)) {
      const key = `${projectPath}:${imported[1]}`;
      if (sideEffectImportAllowances[key]) continue;
      violations.push({
        file: projectPath,
        line: lineAt(source, imported.index ?? 0),
        message: `禁止未登记的副作用导入：${imported[1]}`,
        rule: "side-effect-import",
      });
    }

    const globalPatches: Array<{ index: number; key: string }> = [];
    for (const match of source.matchAll(/axios\.defaults\.[A-Za-z_$][\w$]*/g)) {
      globalPatches.push({ index: match.index ?? 0, key: `${projectPath}:${match[0]}` });
    }
    for (const match of source.matchAll(/getPatcher\(\)\.patch/g)) {
      globalPatches.push({ index: match.index ?? 0, key: `${projectPath}:${match[0]}` });
    }
    for (const patch of globalPatches) {
      if (globalPatchAllowances[patch.key]) continue;
      violations.push({
        file: projectPath,
        line: lineAt(source, patch.index),
        message: "禁止未登记的全局 patch",
        rule: "global-patch",
      });
    }
  }

  for (const file of walkFiles(root)) {
    if (toProjectPath(root, file).endsWith("manifest.json")) {
      violations.push({
        file: toProjectPath(root, file),
        line: 1,
        message: "桌面端产物不得包含浏览器扩展 manifest.json",
        rule: "browser-extension-entrypoint",
      });
    }
  }

  return violations;
}

function main(): void {
  const violations = findArchitectureViolations();
  if (violations.length === 0) return;
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

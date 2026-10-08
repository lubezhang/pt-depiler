import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "typescript";

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(ts|tsx|vue)$/.test(path) && !path.includes(".test.") ? [path] : [];
  });
}

const fix = process.argv.includes("--fix");
let violations = 0;
for (const file of files(resolve("src"))) {
  const original = readFileSync(file, "utf8");
  const script = file.endsWith(".vue") ? /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(original) : undefined;
  if (file.endsWith(".vue") && !script) continue;
  const source = script ? script[1] : original;
  const offset = script ? original.indexOf(script[1], script.index) : 0;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      const args = node.arguments;
      const safe = args.length === 1 && (ts.isStringLiteral(args[0]) || ts.isNoSubstitutionTemplateLiteral(args[0]));
      const envelope =
        args.length === 2 &&
        ts.isStringLiteral(args[0]) &&
        ts.isCallExpression(args[1]) &&
        ts.isIdentifier(args[1].expression) &&
        args[1].expression.text === "createLogRecord";
      if (!safe && !envelope && args.length) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        if (!fix)
          console.error(
            `${relative(process.cwd(), file)}:${line}: console diagnostics must use fixed text or createLogRecord`,
          );
        violations++;
        const first = args[0];
        const message =
          ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)
            ? first.text
            : ts.isTemplateExpression(first)
              ? first.head.text + first.templateSpans.map((span) => span.literal.text).join("")
              : `[diagnostic] ${relative(resolve("src"), file)}:${line}`;
        edits.push({
          start: offset + first.getStart(tree),
          end: offset + args[args.length - 1].end,
          text: JSON.stringify(message),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (fix && edits.length) {
    let updated = original;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
    writeFileSync(file, updated);
  }
}
if (!fix && violations) process.exitCode = 1;

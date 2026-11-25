/**
 * Checks the shipped `cf view` CSS language over every file that it selects in
 * the named Git repositories, read from the named commit of each: whether the
 * colored spans reconstruct the file exactly, which files and lines the grammar
 * could not parse, how the characters other than white space divide among
 * token classes, how many characters without a class lie outside the lines the
 * grammar could not parse, and how many line comments, which CSS does not have,
 * the grammar reads. With `--edits FILE`, it instead inserts each of `(`, `{`, `"`,
 * `}`, and `;` at every offset of that file, and counts the insertions after
 * which the structure walk, restricted to the node types the grammar names,
 * lists different entries from a walk that descends into every node.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming each repository's directory and commit:
 *
 *   deno run --allow-read --allow-env --allow-run=git \
 *     ../../docs/history/packages/cli/cf-view-css-2026-11-coverage.ts \
 *     DIR:COMMIT...
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-css-2026-11-coverage.ts \
 *     --edits test/fixtures/view-language/css-loom/before.css
 */

import { Language, type Node, Parser } from "npm:web-tree-sitter@0.26.12";
import { cssGrammar } from "../../../../runtime/cli/lib/view/languages/css/css.ts";
import { cssLanguage } from "../../../../runtime/cli/lib/view/languages/css/language.ts";
import { languageForFile } from "../../../../runtime/cli/lib/view/languages/language.ts";
import {
  parseDocument,
  prepareGrammar,
} from "../../../../runtime/cli/lib/view/languages/treesitter/adapter.ts";

if (Deno.args[0] === "--edits") {
  const unrestricted = {
    ...cssGrammar,
    id: "css-unrestricted",
    structureParents: undefined,
  };
  await prepareGrammar(cssGrammar);
  await prepareGrammar(unrestricted);
  const entries = (grammar: typeof cssGrammar, text: string) =>
    JSON.stringify(
      parseDocument(grammar, text).flatStructure.map((node) => [
        node.label,
        node.depth,
      ]),
    );
  const source = await Deno.readTextFile(Deno.args[1]);
  let edits = 0;
  let differing = 0;
  for (let offset = 0; offset <= source.length; offset++) {
    for (const inserted of ["(", "{", '"', "}", ";"]) {
      const text = source.slice(0, offset) + inserted + source.slice(offset);
      edits++;
      if (entries(cssGrammar, text) !== entries(unrestricted, text)) {
        differing++;
      }
    }
  }
  console.log(JSON.stringify({ edits, differing }));
  Deno.exit();
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
  }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout);
}

/** The rows that an error or a missing node touches: each error node, and
 * each innermost node holding an error, such as one the parser supplied for a
 * value the source lacks. */
function errorRows(node: Node, rows: Set<number>): void {
  const holding = node.children.filter((child) => child.hasError);
  if (node.type === "ERROR" || holding.length === 0) {
    for (let row = node.startPosition.row; row <= node.endPosition.row; row++) {
      rows.add(row);
    }
    return;
  }
  for (const child of holding) errorRows(child, rows);
}

await cssLanguage.prepare!();
await Parser.init();
const parser = new Parser();
parser.setLanguage(
  await Language.load(await Deno.readFile(new URL(cssGrammar.wasmUrl()))),
);

const counts: Record<string, number> = {};
const filesByRepository: Record<string, number> = {};
const withErrors: Record<string, number> = {};
const notReconstructed: string[] = [];
let files = 0;
let lines = 0;
let errorLines = 0;
let characters = 0;
let unclassifiedOutsideErrors = 0;
let lineComments = 0;
for (const argument of Deno.args) {
  const split = argument.lastIndexOf(":");
  const dir = argument.slice(0, split);
  const commit = argument.slice(split + 1);
  const paths = (await git(dir, "ls-tree", "-r", "--name-only", commit))
    .split("\n").filter((path) => path !== "");
  for (const path of paths) {
    if (languageForFile(path).id !== "css") continue;
    const source = await git(dir, "show", `${commit}:${path}`);
    const name = `${dir}:${path}`;
    files++;
    filesByRepository[dir] = (filesByRepository[dir] ?? 0) + 1;
    const highlighted = cssLanguage.highlightLines(source);
    // Each line break ends a line, and so does the end of a source whose last
    // line has none.
    lines += source.split("\n").length -
      (source === "" || source.endsWith("\n") ? 1 : 0);
    const reconstructed = highlighted.map((line) =>
      line.spans.map((span) => span.text).join("")
    ).join("\n");
    if (reconstructed !== source) notReconstructed.push(name);
    const tree = parser.parse(source)!;
    lineComments += tree.rootNode.descendantsOfType("js_comment").length;
    const rows = new Set<number>();
    if (tree.rootNode.hasError) {
      errorRows(tree.rootNode, rows);
      withErrors[name] = rows.size;
      errorLines += rows.size;
    }
    tree.delete();
    for (const [row, line] of highlighted.entries()) {
      for (const span of line.spans) {
        const length = [...span.text.replace(/\s/gu, "")].length;
        if (length === 0) continue;
        characters += length;
        counts[span.cls] = (counts[span.cls] ?? 0) + length;
        if (span.cls === "plain" && !rows.has(row)) {
          unclassifiedOutsideErrors += length;
        }
      }
    }
  }
}

console.log(JSON.stringify(
  {
    files,
    filesByRepository,
    lines,
    errorLines,
    characters,
    unclassifiedOutsideErrors,
    lineComments,
    withErrors,
    notReconstructed,
    percentByClass: Object.fromEntries(
      Object.entries(counts).sort((a, b) => b[1] - a[1]).map((
        [cls, count],
      ) => [cls, Number((count / characters * 100).toFixed(3))]),
    ),
  },
  null,
  2,
));

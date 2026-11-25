/**
 * Checks the shipped `cf view` HTML language over files named one per line on
 * standard input, such as the output of `git ls-files '*.html'`: whether the
 * grammar parses each file without an error, whether the colored spans
 * reconstruct each file exactly, how the characters other than white space
 * divide among token classes, how many of the uncolored ones are outside the
 * text of elements, how many `script` and `style` elements and `style`
 * attributes the files hold, and how many stretches each embedded language
 * colors. With
 * `--edits FILE`, it instead inserts each of `<`, `>`, `"`, and `/` at every
 * offset of that file, and counts the insertions after which the structure
 * walk, restricted to the node types the grammar names, lists different
 * entries from a walk that descends into every node.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * from inside the repository to check:
 *
 *   git -C REPO ls-files '*.html' '*.htm' | sed "s|^|REPO/|" | \
 *     deno run --allow-read --allow-env \
 *       ../../docs/history/packages/cli/cf-view-html-2026-11-coverage.ts
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-html-2026-11-coverage.ts \
 *     --edits test/fixtures/view-language/html-loom/before.html
 */

import { Language, Parser } from "npm:web-tree-sitter@0.26.12";
import { htmlGrammar } from "../../../../runtime/cli/lib/view/languages/html/html.ts";
import { htmlLanguage } from "../../../../runtime/cli/lib/view/languages/html/language.ts";
import { languageForFile } from "../../../../runtime/cli/lib/view/languages/language.ts";
import {
  parseDocument,
  prepareGrammar,
} from "../../../../runtime/cli/lib/view/languages/treesitter/adapter.ts";

if (Deno.args[0] === "--edits") {
  const unrestricted = {
    ...htmlGrammar,
    id: "html-unrestricted",
    structureParents: undefined,
  };
  await htmlLanguage.prepare!();
  await prepareGrammar(unrestricted);
  const entries = (grammar: typeof htmlGrammar, text: string) =>
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
    for (const inserted of ["<", ">", '"', "/"]) {
      const text = source.slice(0, offset) + inserted + source.slice(offset);
      edits++;
      if (entries(htmlGrammar, text) !== entries(unrestricted, text)) {
        differing++;
      }
    }
  }
  console.log(JSON.stringify({ edits, differing }));
  Deno.exit();
}

await htmlLanguage.prepare!();
await Parser.init();
const parser = new Parser();
parser.setLanguage(
  await Language.load(await Deno.readFile(new URL(htmlGrammar.wasmUrl()))),
);

const paths = (await new Response(Deno.stdin.readable).text()).split("\n")
  .filter((path) => path !== "");
const counts: Record<string, number> = {};
const regions = { script: 0, style: 0, styleAttribute: 0 };
const stretches: Record<string, number> = {};
const files: {
  path: string;
  bytes: number;
  errorLines: number;
  lines: number;
}[] = [];
const notReconstructed: string[] = [];
const notSelected: string[] = [];
let characters = 0;
let uncoloredCode = 0;
for (const path of paths) {
  if (languageForFile(path).id !== "html") {
    notSelected.push(path);
    continue;
  }
  const source = await Deno.readTextFile(path);
  const lines = htmlLanguage.highlightLines(source);
  const reconstructed = lines.map((line) =>
    line.spans.map((span) => span.text).join("")
  ).join("\n");
  if (reconstructed !== source) notReconstructed.push(path);
  const tree = parser.parse(source)!;
  const inText = new Uint8Array(source.length);
  for (const text of tree.rootNode.descendantsOfType(["text"])) {
    inText.fill(1, text.startIndex, text.endIndex);
  }
  let offset = 0;
  for (const line of lines) {
    for (const span of line.spans) {
      for (let i = 0; i < span.text.length; i++, offset++) {
        if (/\s/.test(span.text[i])) continue;
        characters++;
        counts[span.cls] = (counts[span.cls] ?? 0) + 1;
        if (span.cls === "plain" && inText[offset] === 0) uncoloredCode++;
      }
    }
    offset++;
  }
  const errorRows = new Set<number>();
  for (const node of tree.rootNode.descendantsOfType(["ERROR"])) {
    for (let row = node.startPosition.row; row <= node.endPosition.row; row++) {
      errorRows.add(row);
    }
  }
  for (const tag of tree.rootNode.descendantsOfType(["start_tag"])) {
    const name = tag.firstNamedChild?.text.toLowerCase();
    if (name === "script") regions.script++;
    if (name === "style") regions.style++;
  }
  for (const name of tree.rootNode.descendantsOfType(["attribute_name"])) {
    if (name.text.toLowerCase() === "style") regions.styleAttribute++;
  }
  for (const stretch of htmlGrammar.embedded!(tree.rootNode)) {
    const language = stretch.slot.split("\n")[0];
    stretches[language] = (stretches[language] ?? 0) + 1;
  }
  files.push({
    path,
    bytes: new TextEncoder().encode(source).length,
    errorLines: tree.rootNode.hasError ? Math.max(errorRows.size, 1) : 0,
    lines: lines.length,
  });
  tree.delete();
}

const withErrors = files.filter((file) => file.errorLines > 0);
console.log(JSON.stringify(
  {
    files: files.length,
    lines: files.reduce((sum, file) => sum + file.lines, 0),
    characters,
    uncoloredCode,
    regions,
    stretches,
    withErrors: withErrors.map(({ path, errorLines, lines }) => ({
      path,
      errorLines,
      lines,
    })),
    errorLines: withErrors.reduce((sum, file) => sum + file.errorLines, 0),
    notReconstructed,
    notSelected,
    percentByClass: Object.fromEntries(
      Object.entries(counts).sort((a, b) => b[1] - a[1]).map((
        [cls, count],
      ) => [cls, Number((count / characters * 100).toFixed(2))]),
    ),
  },
  null,
  2,
));

/**
 * Checks the shipped `cf view` HCL language over every file under a directory
 * that it selects: whether the grammar parses the file without an error,
 * whether the colored spans reconstruct the file exactly, and how the
 * characters other than white space divide among token classes. With
 * `--edits FILE`, it instead inserts each of `(`, `{`, `"`, and `}` at every
 * offset of that file, and counts the insertions after which the structure
 * walk, restricted to the node types the grammar names, lists different entries
 * from a walk that descends into every node.
 *
 * Run it from `packages/cli`, which is where the parser packages are declared,
 * naming a directory:
 *
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-hcl-2026-10-coverage.ts DIR
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-hcl-2026-10-coverage.ts \
 *     --edits test/fixtures/view-language/hcl-infra/before.tf
 */

import { walk } from "jsr:@std/fs@1/walk";
import { Language, Parser } from "npm:web-tree-sitter@0.26.12";
import { hclGrammar } from "../../../../packages/cli/lib/view/languages/hcl/hcl.ts";
import { hclLanguage } from "../../../../packages/cli/lib/view/languages/hcl/language.ts";
import { languageForFile } from "../../../../packages/cli/lib/view/languages/language.ts";
import {
  parseDocument,
  prepareGrammar,
} from "../../../../packages/cli/lib/view/languages/treesitter/adapter.ts";

if (Deno.args[0] === "--edits") {
  const unrestricted = {
    ...hclGrammar,
    id: "hcl-unrestricted",
    structureParents: undefined,
  };
  await prepareGrammar(hclGrammar);
  await prepareGrammar(unrestricted);
  const entries = (grammar: typeof hclGrammar, text: string) =>
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
    for (const inserted of ["(", "{", '"', "}"]) {
      const text = source.slice(0, offset) + inserted + source.slice(offset);
      edits++;
      if (entries(hclGrammar, text) !== entries(unrestricted, text)) {
        differing++;
      }
    }
  }
  console.log(JSON.stringify({ edits, differing }));
  Deno.exit();
}

await hclLanguage.prepare!();
await Parser.init();
const parser = new Parser();
parser.setLanguage(
  await Language.load(await Deno.readFile(new URL(hclGrammar.wasmUrl()))),
);

const counts: Record<string, number> = {};
const withErrors: string[] = [];
const notReconstructed: string[] = [];
let files = 0;
let characters = 0;
for await (const entry of walk(Deno.args[0], { includeDirs: false })) {
  if (languageForFile(entry.path).id !== "hcl") continue;
  const source = await Deno.readTextFile(entry.path);
  files++;
  const lines = hclLanguage.highlightLines(source);
  const reconstructed = lines.map((line) =>
    line.spans.map((span) => span.text).join("")
  ).join("\n");
  if (reconstructed !== source) notReconstructed.push(entry.path);
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.cls === "whitespace") continue;
      const length = [...span.text].length;
      characters += length;
      counts[span.cls] = (counts[span.cls] ?? 0) + length;
    }
  }
  const tree = parser.parse(source)!;
  if (tree.rootNode.hasError) withErrors.push(entry.path);
  tree.delete();
}

console.log(JSON.stringify(
  {
    files,
    characters,
    withErrors,
    notReconstructed,
    percentByClass: Object.fromEntries(
      Object.entries(counts).sort((a, b) => b[1] - a[1]).map((
        [cls, count],
      ) => [cls, Number((count / characters * 100).toFixed(2))]),
    ),
  },
  null,
  2,
));

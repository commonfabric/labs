/**
 * Checks the shipped `cf view` Go, Go module file, and Go checksum file
 * languages over every file that selects one of them in the named Git trees:
 * whether the colored spans reconstruct each file exactly, how the characters
 * other than white space divide among token classes, and, for Go source, which
 * files hold a region the grammar could not parse and how many lines those
 * regions cover. With `--edits FILE`, it instead inserts each of `(`, `{`,
 * `"`, and `}` at every offset of that Go file, and counts the insertions after
 * which the structure walk, restricted to the node types the grammar names,
 * lists different entries from a walk that descends into every node and leaves
 * out the declarations inside a block, as the restriction does by design.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming each repository and the commit or branch to read:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-go-2026-11-coverage.ts \
 *     ~/dev/commonfabric/gvisor/root=origin/cfc_v2 ...
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-go-2026-11-coverage.ts \
 *     --edits test/fixtures/view-language/go-gvisor/before.go
 */

import { Language, Parser } from "npm:web-tree-sitter@0.26.12";
import { goGrammar } from "../../../../runtime/cli/lib/view/languages/go/go.ts";
import { languageForFile } from "../../../../runtime/cli/lib/view/languages/language.ts";
import {
  parseDocument,
  prepareGrammar,
  type SyntaxNode,
} from "../../../../runtime/cli/lib/view/languages/treesitter/adapter.ts";

if (Deno.args[0] === "--edits") {
  // The unrestricted walk descends into every node, and leaves out what the
  // restriction leaves out by design: the declarations inside a block.
  const unrestricted = {
    ...goGrammar,
    id: "go-unrestricted",
    structureParents: undefined,
    structureEntry: (node: SyntaxNode) => {
      for (let parent = node.parent; parent !== null; parent = parent.parent) {
        if (parent.type === "block") return undefined;
      }
      return goGrammar.structureEntry(node);
    },
  };
  await prepareGrammar(goGrammar);
  await prepareGrammar(unrestricted);
  const entries = (grammar: typeof goGrammar, text: string) =>
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
      if (entries(goGrammar, text) !== entries(unrestricted, text)) {
        differing++;
      }
    }
  }
  console.log(JSON.stringify({ edits, differing }));
  Deno.exit();
}

await prepareGrammar(goGrammar);
await Parser.init();
const parser = new Parser();
parser.setLanguage(
  await Language.load(await Deno.readFile(new URL(goGrammar.wasmUrl()))),
);

async function git(repository: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args: ["-C", repository, ...args],
    stdout: "piped",
  }).output();
  if (!output.success) throw new Error(`git ${args.join(" ")} failed`);
  return new TextDecoder().decode(output.stdout);
}

interface Tally {
  files: number;
  lines: number;
  characters: number;
  readonly counts: Record<string, number>;
  readonly notReconstructed: string[];
}

const tallies: Record<string, Tally> = {};
const withErrors: { path: string; errorLines: number; lines: number }[] = [];
for (const argument of Deno.args) {
  const [repository, ref] = argument.split("=");
  const name = repository.replace(/\/root\/?$/, "").split("/").at(-1);
  const paths = (await git(repository, "ls-tree", "-r", "--name-only", ref))
    .split("\n").filter((path) => path !== "");
  for (const path of paths) {
    const language = languageForFile(path);
    if (!language.id.startsWith("go")) continue;
    const source = await git(repository, "show", `${ref}:${path}`);
    const label = `${name}/${path}`;
    const tally = tallies[language.id] ??= {
      files: 0,
      lines: 0,
      characters: 0,
      counts: {},
      notReconstructed: [],
    };
    tally.files++;
    const lines = language.highlightLines(source);
    tally.lines += lines.length;
    const reconstructed = lines.map((line) =>
      line.spans.map((span) => span.text).join("")
    ).join("\n");
    if (reconstructed !== source) tally.notReconstructed.push(label);
    for (const line of lines) {
      for (const span of line.spans) {
        if (span.cls === "whitespace") continue;
        const length = [...span.text].length;
        tally.characters += length;
        tally.counts[span.cls] = (tally.counts[span.cls] ?? 0) + length;
      }
    }
    if (language.id !== "go") continue;
    const tree = parser.parse(source)!;
    if (tree.rootNode.hasError) {
      const rows = new Set<number>();
      for (const node of tree.rootNode.descendantsOfType("ERROR")) {
        for (let row = node.startPosition.row; row <= node.endPosition.row;) {
          rows.add(row++);
        }
      }
      withErrors.push({ path: label, errorLines: rows.size, lines: lines.length });
    }
    tree.delete();
  }
}

console.log(JSON.stringify(
  {
    languages: Object.fromEntries(
      Object.entries(tallies).map(([id, tally]) => [id, {
        files: tally.files,
        lines: tally.lines,
        characters: tally.characters,
        notReconstructed: tally.notReconstructed,
        charactersByClass: tally.counts,
        percentByClass: Object.fromEntries(
          Object.entries(tally.counts).sort((a, b) => b[1] - a[1]).map((
            [cls, count],
          ) => [cls, Number((count / tally.characters * 100).toFixed(3))]),
        ),
      }]),
    ),
    goFilesWithErrors: withErrors,
  },
  null,
  2,
));

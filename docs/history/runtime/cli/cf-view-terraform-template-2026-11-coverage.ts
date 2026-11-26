/**
 * Checks the shipped `cf view` Terraform template language over every
 * `.tftpl` file under a directory: which language the file selects and over
 * which host, whether the colored spans reconstruct the file exactly, how the
 * characters other than white space divide among token classes, how many of
 * each kind of template sequence the files hold, and how many characters other
 * than white space inside the sequences are left plain.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming a directory:
 *
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/runtime/cli/cf-view-terraform-template-2026-11-coverage.ts DIR
 */

import { walk } from "jsr:@std/fs@1/walk";
import {
  languageForSource,
  prepareLanguages,
} from "../../../../runtime/cli/lib/view/languages/language.ts";
import { terraformTemplateSyntax } from "../../../../runtime/cli/lib/view/languages/terraform-template/terraform-template.ts";

const counts: Record<string, number> = {};
const sequences: Record<string, number> = {};
const selected: Record<string, string> = {};
const notReconstructed: string[] = [];
let characters = 0;
let sequenceCharacters = 0;
let plainInSequences = 0;
for await (const entry of walk(Deno.args[0], { includeDirs: false })) {
  if (!entry.path.toLowerCase().endsWith(".tftpl")) continue;
  const source = await Deno.readTextFile(entry.path);
  const language = languageForSource(entry.path, source);
  selected[entry.path] = language.id;
  await prepareLanguages([language]);
  const lines = language.highlightLines(source, entry.path);
  const reconstructed = lines.map((line) =>
    line.spans.map((span) => span.text).join("")
  ).join("\n");
  if (reconstructed !== source) notReconstructed.push(entry.path);

  // The class of each character, read back from the colored lines, with the
  // line breaks between them.
  const classAt: string[] = [];
  for (const line of lines) {
    for (const span of line.spans) {
      for (let i = 0; i < span.text.length; i++) classAt.push(span.cls);
    }
    classAt.push("whitespace");
  }
  const counted = (at: number) => /\S/.test(source[at]);
  for (let at = 0; at < source.length; at++) {
    if (!counted(at)) continue;
    characters++;
    counts[classAt[at]] = (counts[classAt[at]] ?? 0) + 1;
  }

  for (const { start, end } of terraformTemplateSyntax.scan(source).regions) {
    const text = source.slice(start, end);
    const kind = text[1] === "{" ? text.slice(0, 2) : `escape ${text}${text}{`;
    sequences[kind] = (sequences[kind] ?? 0) + 1;
    for (let i = start; i < end; i++) {
      if (!counted(i)) continue;
      sequenceCharacters++;
      if (classAt[i] === "plain") plainInSequences++;
    }
  }
}

console.log(JSON.stringify(
  {
    files: Object.keys(selected).length,
    selected,
    sequences,
    sequenceCharacters,
    plainInSequences,
    characters,
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

/**
 * Shared fixture contract for every editable text language supported by
 * `cf view`. Each corpus entry covers direct source, a diff, an incomplete
 * live edit, and every representative selection route recorded for it.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type DiffLine,
  type DiffLineKind,
  parseDiff,
} from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import {
  decodeLanguageInput,
  languageForName,
  languageForSource,
  languageIds,
  prepareLanguages,
} from "../lib/view/languages/language.ts";
import type { Line, TokenClass } from "../lib/view/model.ts";
import {
  type HighlightEvidence,
  VIEW_LANGUAGE_FIXTURES,
} from "./fixtures/view-language/corpus.ts";

// Every fixture is parsed through its language's synchronous entry points,
// which show plain text until the language's parser has loaded.
await prepareLanguages(languageIds().map((id) => languageForName(id)!));

const UNAVAILABLE_WORKSPACE: DiffWorkspace = {
  resolve: () => null,
  read: () => null,
};

/** Reconstruct source text from the spans rendered for each source line. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Return the token classes assigned to an exact fixture fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return lines.flatMap((line) =>
    line.spans.filter((span) => span.text === text).map((span) => span.cls)
  );
}

/** Assert that the fixture fragment has its language-specific token class. */
function expectEvidence(
  lines: readonly Line[],
  evidence: HighlightEvidence,
): void {
  expect(classesOf(lines, evidence.text)).toContain(evidence.className);
}

/** Assert that no other text-language highlighter produces the evidence. */
function expectLanguageSpecificEvidence(
  source: string,
  fileName: string,
  languageId: string,
  evidence: HighlightEvidence,
  highlightingPeers: readonly string[] = [],
): void {
  for (const otherId of languageIds()) {
    if (otherId === languageId || highlightingPeers.includes(otherId)) {
      continue;
    }
    const other = languageForName(otherId);
    if (other?.input.kind !== "text") continue;
    const lines = other.highlightLines(source, fileName);
    expect(classesOf(lines, evidence.text)).not.toContain(evidence.className);
  }
}

/** Build one whole-file unified diff without changing either fixture source. */
function wholeFileDiff(
  fileName: string,
  before: string,
  after: string,
): string {
  const beforeLines = sourceLines(before);
  const afterLines = sourceLines(after);
  return [
    `diff --git a/${fileName} b/${fileName}`,
    `--- a/${fileName}`,
    `+++ b/${fileName}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...(hasFinalNewline(before) ? [] : ["\\ No newline at end of file"]),
    ...afterLines.map((line) => `+${line}`),
    ...(hasFinalNewline(after) ? [] : ["\\ No newline at end of file"]),
    "",
  ].join("\n");
}

/** Report whether a non-empty source has a final line terminator. */
function hasFinalNewline(source: string): boolean {
  return source.length === 0 || source.endsWith("\n");
}

/** Split source into diff lines without inventing one after a final newline. */
function sourceLines(source: string): string[] {
  if (source.length === 0) return [];
  const content = source.endsWith("\n") ? source.slice(0, -1) : source;
  return content.split("\n");
}

/** Reconstruct one side of a whole-file diff from its rendered lines. */
function reconstructDiffSide(
  lines: readonly Line[],
  diffLines: readonly DiffLine[],
  kind: Extract<DiffLineKind, "add" | "del">,
): string {
  const selected: string[] = [];
  let lastSelected = -1;
  for (let index = 0; index < diffLines.length; index++) {
    if (diffLines[index].kind !== kind) continue;
    selected.push(lines[index].text.slice(1));
    lastSelected = index;
  }
  if (selected.length === 0) return "";

  const marker = lines[lastSelected + 1]?.text;
  const hasFinalNewline = marker !== "\\ No newline at end of file";
  return selected.join("\n") + (hasFinalNewline ? "\n" : "");
}

describe("view language fixture corpus", () => {
  it("covers every registered text language", () => {
    // A language may have several fixtures, one per surveyed repository; what
    // the corpus owes is one for each registered text language.
    const textLanguageIds = languageIds().filter((id) =>
      languageForName(id)?.input.kind === "text"
    );
    expect([
      ...new Set(VIEW_LANGUAGE_FIXTURES.map((fixture) => fixture.languageId)),
    ]).toEqual(textLanguageIds);
  });

  it("records every language's selection routes on one of its fixtures", () => {
    const withSelection = VIEW_LANGUAGE_FIXTURES.filter((fixture) =>
      fixture.selection !== undefined
    ).map((fixture) => fixture.languageId);

    expect(withSelection).toEqual([...new Set(withSelection)]);
    expect(new Set(withSelection)).toEqual(
      new Set(VIEW_LANGUAGE_FIXTURES.map((fixture) => fixture.languageId)),
    );
  });

  it("preserves missing final newlines in generated fixture diffs", () => {
    const before = "before";
    const after = "after";
    const diff = wholeFileDiff("fixture.txt", before, after);
    const model = parseDiff(diff);

    expect(model).not.toBeNull();
    const { doc } = buildDiffDocument(diff, model!, UNAVAILABLE_WORKSPACE);
    expect(reconstructDiffSide(doc.lines, model!.lines, "del")).toBe(before);
    expect(reconstructDiffSide(doc.lines, model!.lines, "add")).toBe(after);
  });

  for (const fixture of VIEW_LANGUAGE_FIXTURES) {
    describe(`${fixture.languageId} from ${fixture.surveyRepository}`, () => {
      const before = Deno.readTextFileSync(fixture.before);
      const after = Deno.readTextFileSync(fixture.after);
      const incomplete = Deno.readTextFileSync(fixture.incomplete);

      it("selects the language from its own surveyed path", () => {
        expect(languageForSource(fixture.surveyPath, after).id).toBe(
          fixture.languageId,
        );
      });

      const selection = fixture.selection;
      if (selection !== undefined) {
        it("selects the language from representative filenames, aliases, and shebangs", () => {
          for (const fileName of selection.filenames) {
            expect(languageForSource(fileName, after).id).toBe(
              fixture.languageId,
            );
          }
          for (const alias of selection.aliases) {
            expect(languageForName(alias)?.id).toBe(fixture.languageId);
          }
          for (const shebang of selection.shebangs ?? []) {
            expect(languageForSource(undefined, `${shebang}\n${after}`).id)
              .toBe(fixture.languageId);
          }
        });
      }

      it("uses highlighting evidence specific to the language adapter", () => {
        expectLanguageSpecificEvidence(
          before,
          fixture.surveyPath,
          fixture.languageId,
          fixture.beforeEvidence,
          fixture.highlightingPeers,
        );
        expectLanguageSpecificEvidence(
          after,
          fixture.surveyPath,
          fixture.languageId,
          fixture.afterEvidence,
          fixture.highlightingPeers,
        );
        expectLanguageSpecificEvidence(
          incomplete,
          fixture.surveyPath,
          fixture.languageId,
          fixture.incompleteEvidence,
          fixture.highlightingPeers,
        );
      });

      it("reconstructs a direct file exactly with language highlighting", () => {
        const bytes = Deno.readFileSync(fixture.after);
        const { language, source } = decodeLanguageInput(
          fixture.surveyPath,
          bytes,
        );
        const document = language.parseDocument(
          source.text,
          fixture.surveyPath,
        );
        const highlighted = language.highlightLines(
          source.text,
          fixture.surveyPath,
        );

        expect(language.id).toBe(fixture.languageId);
        expect(source.encode(source.text)).toEqual(bytes);
        expect(document.text).toBe(source.text);
        expect(verbatim(document.lines)).toBe(source.text);
        expect(verbatim(highlighted)).toBe(source.text);
        expectEvidence(document.lines, fixture.afterEvidence);
        expectEvidence(highlighted, fixture.afterEvidence);
      });

      it("reconstructs both sides of a diff with language highlighting", () => {
        const diff = wholeFileDiff(fixture.surveyPath, before, after);
        const model = parseDiff(diff);

        expect(model).not.toBeNull();
        const { doc } = buildDiffDocument(
          diff,
          model!,
          UNAVAILABLE_WORKSPACE,
        );
        expect(verbatim(doc.lines)).toBe(diff);
        expect(reconstructDiffSide(doc.lines, model!.lines, "del")).toBe(
          before,
        );
        expect(reconstructDiffSide(doc.lines, model!.lines, "add")).toBe(
          after,
        );
        expectEvidence(
          doc.lines.filter((line) => line.bg === "del"),
          fixture.beforeEvidence,
        );
        expectEvidence(
          doc.lines.filter((line) => line.bg === "add"),
          fixture.afterEvidence,
        );
      });

      it("reconstructs an incomplete live edit with language highlighting", () => {
        const language = languageForSource(fixture.surveyPath, before);
        const highlighter = language.createHighlighter(
          before,
          fixture.surveyPath,
        );
        const lines = highlighter.update(incomplete);

        expect(verbatim(lines)).toBe(incomplete);
        expectEvidence(lines, fixture.incompleteEvidence);
      });
    });
  }
});

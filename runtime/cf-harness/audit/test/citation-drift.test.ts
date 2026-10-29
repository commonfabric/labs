/**
 * The audit is an expression of the specification, so the specification is
 * what has to be able to break it. Each citation quotes the clause it rests
 * on verbatim; this suite reads every cited document and requires each quote
 * to still be in it. A clause reworded past its quote fails here, which is
 * the notice that the check resting on it needs rewriting too.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";

import { RUN_CHECKS } from "../checks/registry.ts";
import { SPEC_CITATIONS } from "../citations.ts";
import { MATRIX_RULES } from "../matrix.ts";

const REPO_ROOT = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * A document's text with every run of whitespace collapsed to one space.
 *
 * A quote is a sentence, and a sentence in a Markdown document is wrapped at
 * whatever column it happened to land on. Comparing against the collapsed
 * text makes a rewrap invisible and a rewording loud, which is the split the
 * suite wants.
 */
const collapsed = (text: string): string => text.replace(/\s+/g, " ");

const documents = new Map<string, string>();
const documentText = async (doc: string): Promise<string> => {
  const held = documents.get(doc);
  if (held !== undefined) {
    return held;
  }
  const text = collapsed(await Deno.readTextFile(join(REPO_ROOT, doc)));
  documents.set(doc, text);
  return text;
};

describe("citation drift", () => {
  describe("SPEC_CITATIONS", () => {
    for (const [key, citation] of Object.entries(SPEC_CITATIONS)) {
      it(`quotes ${key} verbatim from its document`, async () => {
        expect(await documentText(citation.doc)).toContain(
          collapsed(citation.quote),
        );
      });
    }

    it("names a clause id for every citation", () => {
      expect(
        Object.values(SPEC_CITATIONS).filter((citation) =>
          citation.clause.length === 0
        ),
      ).toEqual([]);
    });

    it("carries no line numbers, which a document edit silently invalidates", () => {
      expect(
        Object.values(SPEC_CITATIONS).filter((citation) =>
          /:\d+/.test(citation.doc)
        ),
      ).toEqual([]);
    });
  });

  describe("RUN_CHECKS", () => {
    it("cites at least one clause from every check", () => {
      expect(
        RUN_CHECKS.filter((check) => check.citations.length === 0)
          .map((check) => check.id),
      ).toEqual([]);
    });

    it("cites only clauses the citation table holds", () => {
      const known = new Set<string>(
        Object.values(SPEC_CITATIONS).map((citation) => citation.clause),
      );
      expect(
        RUN_CHECKS.flatMap((check) =>
          check.citations
            .filter((citation) => !known.has(citation.clause))
            .map((citation) => `${check.id} ${citation.clause}`)
        ),
      ).toEqual([]);
    });
  });

  describe("citation kinds", () => {
    it("gives every citation a kind", () => {
      // A citation with no kind is one whose authority nobody decided about,
      // and it renders as though the specification demanded the check.
      expect(
        RUN_CHECKS.flatMap((check) =>
          check.citations
            .filter((citation) =>
              citation.kind !== "required-by" && citation.kind !== "extends"
            )
            .map((citation) => `${check.id} ${citation.clause}`)
        ),
      ).toEqual([]);
    });

    it("keeps the checks that rest on the specification separable from the checks that do not", () => {
      // Not an assertion that either set is right — an assertion that the
      // split is visible, so a reader of a finding can tell which they hold.
      const restingOnSpec = RUN_CHECKS
        .filter((check) =>
          check.citations.some((citation) => citation.kind === "required-by")
        )
        .map((check) => check.id);
      expect(restingOnSpec).toEqual([
        "AUD-1",
        "AUD-2",
        "AUD-3",
        "AUD-4",
        "AUD-5",
        "AUD-6",
        "AUD-7",
        "AUD-8",
        "AUD-9",
        "AUD-13",
        "AUD-15",
        "AUD-22",
        "AUD-23",
      ]);
    });
  });

  describe("MATRIX_RULES", () => {
    it("leaves no matrix citation nothing rests on", () => {
      // A quote nothing cites is a quote nobody has to keep true, which is the
      // drift this suite exists to catch one step earlier.
      const cited = new Set<string>([
        ...MATRIX_RULES.map((rule) => rule.citation),
        // AUD-13 cites it directly, for the definition of a conforming state.
        "MATRIX-conforming",
      ]);
      expect(
        Object.entries(SPEC_CITATIONS)
          .filter(([key, citation]) =>
            citation.doc === "docs/specs/cfc-enforcement-matrix.md" &&
            !cited.has(key)
          )
          .map(([key]) => key),
      ).toEqual([]);
    });

    it("states what is wrong with a violating tuple, for every rule", () => {
      expect(
        MATRIX_RULES.filter((rule) => rule.statement.trim() === "")
          .map((rule) => rule.id),
      ).toEqual([]);
    });

    it("gives every rule a distinct id", () => {
      expect(new Set(MATRIX_RULES.map((rule) => rule.id)).size).toBe(
        MATRIX_RULES.length,
      );
    });
  });
});

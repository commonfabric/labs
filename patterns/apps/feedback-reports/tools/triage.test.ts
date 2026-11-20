import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Report } from "./read.ts";
import {
  bodyOf,
  commentOf,
  isTrusted,
  parseTrusted,
  plainWords,
  planTriage,
  titleOf,
} from "./triage.ts";

const ADA = "did:key:z6MkAda";
const EVE = "did:key:z6MkEve";
const TRUSTED = new Set([ADA]);

/** Words no Topic may carry. */
const SECRET = "Lunch with Pat about the merger";

/** The id the tests give the report named `name`. */
const idOf = (name: string) => `id-${name}`;

/** A report Ada sent about a want stopped at `stop` by `cause`. */
function report(
  name: string,
  { cause = "auth-expired", stop = "gmail-sync", release = "2026.11.18" } = {},
  rest: Partial<Report> = {},
): Report {
  return {
    id: idOf(name),
    name,
    kind: "broke",
    words: SECRET,
    structured: {
      source: "failure-card",
      cfs: { release },
      want: { id: `want-${name}`, cause, stop, retries: 2, since: 1 },
      commands: [],
      failingProbes: [],
    },
    createdAt: 1,
    authors: [ADA],
    ...rest,
  };
}

/** A report Ada sent naming only a failing probe. */
function probeReport(name: string, release = "2026.11.18"): Report {
  return report(name, {}, {
    structured: {
      source: "report",
      cfs: { release },
      failingProbes: [{ connector: "gmail", probe: "token-valid" }],
    },
  });
}

describe("triage", () => {
  describe("parseTrusted()", () => {
    it("returns one DID per line, without blanks or comments", () => {
      expect(parseTrusted(`${ADA}\n\n# the team\n  ${EVE} # alpha\n`))
        .toEqual(new Set([ADA, EVE]));
    });
  });

  describe("isTrusted()", () => {
    it("returns `true` only when every author is listed and one is named", () => {
      expect(isTrusted(report("a"), TRUSTED)).toBe(true);
      expect(isTrusted(report("a", {}, { authors: [EVE] }), TRUSTED)).toBe(
        false,
      );
      expect(isTrusted(report("a", {}, { authors: [ADA, EVE] }), TRUSTED))
        .toBe(false);
      expect(isTrusted(report("a", {}, { authors: [] }), TRUSTED)).toBe(false);
      expect(
        isTrusted(report("a", {}, { unreadable: true }), TRUSTED),
      ).toBe(false);
    });
  });

  describe("titleOf() and bodyOf()", () => {
    it("returns a title and body from the structured fields alone", () => {
      const reports = [report("quiet-heron-41"), report("calm-otter-7")];

      expect(titleOf(reports)).toBe(
        "[feedback] Weaver: auth expired, stops at gmail sync",
      );
      const body = bodyOf(reports);
      expect(body.startsWith("What is asked: Find the cause")).toBe(true);
      expect(body).toContain("- Reports: quiet heron 41, calm otter 7");
      expect(body).toContain("- Cause: auth expired");
      expect(body).toContain("- Stop: gmail sync");
      expect(body).toContain("- Retries: 2");
      expect(body).toContain("- CFS releases: 2026.11.18");
      expect(body).toContain("- Count: 2");
    });

    it("never carries a report's words", () => {
      const reports = [report("a"), probeReport("b")];

      expect(titleOf(reports)).not.toContain("Pat");
      expect(bodyOf(reports)).not.toContain("Pat");
      expect(commentOf([reports[0]], [probeReport("c", "2026.12.01")]))
        .not.toContain("Pat");
    });

    it("titles a problem with no cause by its probe, and asks for a product call on a wish", () => {
      expect(titleOf([probeReport("a")])).toBe(
        "[feedback] gmail: probe token valid fails",
      );
      const wish = report("w", {}, {
        kind: "wish",
        structured: { source: "report" },
      });
      expect(titleOf([wish])).toBe("[feedback] Weaver: a wish");
      expect(bodyOf([wish])).toContain("What is asked: Make a product call");
    });
  });

  describe("plainWords()", () => {
    it("returns an identifier with no Markdown, link or line break left in it", () => {
      expect(plainWords("auth-expired\n# [click](javascript:x)"))
        .toBe("auth expired clickjavascript:x");
      expect(plainWords("x".repeat(100))).toHaveLength(80);
    });
  });

  describe("planTriage()", () => {
    it("files one Topic for new reports sharing a cause and stop, and another for a different one", () => {
      const plan = planTriage(
        [
          report("a"),
          report("b"),
          report("c", { cause: "rate-limited" }),
        ],
        TRUSTED,
      );

      expect(plan.file.map((filing) => filing.reports)).toEqual([
        [idOf("a"), idOf("b")],
        [idOf("c")],
      ]);
      expect(plan.update).toEqual([]);
    });

    it("does not group reports sharing a cause with another stop", () => {
      const plan = planTriage(
        [report("a"), report("b", { stop: "calendar-sync" })],
        TRUSTED,
      );

      expect(plan.file).toHaveLength(2);
    });

    it("adds a new report to the Topic of a filed problem it matches, rewriting the count without a comment", () => {
      const plan = planTriage(
        [report("a", {}, { topic: "of:topic-1" }), report("b")],
        TRUSTED,
      );

      expect(plan.file).toEqual([]);
      expect(plan.update).toEqual([{
        topic: "of:topic-1",
        body: bodyOf([report("a"), report("b")]),
        reports: [idOf("b")],
      }]);
    });

    it("comments when a new report brings a release or a stop the problem did not have", () => {
      const plan = planTriage(
        [
          probeReport("a"),
          report("p", {}, {
            topic: "of:topic-1",
            structured: probeReport("p").structured,
          }),
          probeReport("b", "2026.12.01"),
        ],
        TRUSTED,
      );

      expect(plan.update).toHaveLength(1);
      expect(plan.update[0].reports).toEqual([idOf("a"), idOf("b")]);
      expect(plan.update[0].comment).toBe(
        "New reports: a, b.\nNew CFS releases: 2026.12.01.\n3 reports now.",
      );
    });

    it("files nothing for an untrusted or unreadable sender, and only counts them", () => {
      const plan = planTriage(
        [
          report("a", {}, { authors: [EVE] }),
          report("b", {}, { authors: [] }),
          report("c", {}, { unreadable: true, authors: [] }),
        ],
        TRUSTED,
      );

      expect(plan).toEqual({
        file: [],
        update: [],
        untrusted: 2,
        unreadable: 1,
      });
    });

    it("does not let an untrusted report linked to a Topic decide what that problem is", () => {
      const plan = planTriage(
        [report("a", {}, { topic: "of:topic-1", authors: [EVE] }), report("b")],
        TRUSTED,
      );

      expect(plan.update).toEqual([]);
      expect(plan.file.map((filing) => filing.reports)).toEqual([[idOf("b")]]);
    });

    it("tells apart two reports sharing a name by their ids", () => {
      const ours = report("quiet-heron-41", {}, { topic: "of:topic-1" });
      const theirs = report("quiet-heron-41", { cause: "rate-limited" }, {
        id: "id-other-install",
      });

      const plan = planTriage([ours, theirs], TRUSTED);

      expect(plan.update).toEqual([]);
      expect(plan.file.map((filing) => filing.reports)).toEqual([
        ["id-other-install"],
      ]);
    });

    it("leaves a report already linked alone", () => {
      const plan = planTriage(
        [report("a", {}, { topic: "of:topic-1" })],
        TRUSTED,
      );

      expect(plan).toEqual({
        file: [],
        update: [],
        untrusted: 0,
        unreadable: 0,
      });
    });
  });
});

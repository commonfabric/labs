import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Report } from "./read.ts";
import {
  commentOf,
  INVALID,
  isTrusted,
  listed,
  MAX_LISTED,
  parseTrusted,
  planTriage,
  SECTION_END,
  SECTION_START,
  sectionOf,
  titleOf,
  withSection,
} from "./triage.ts";

const ADA = "did:key:z6MkAda";
const EVE = "did:key:z6MkEve";
const TRI = "did:key:z6MkTriager";
const TRUSTED = new Set([ADA]);
const TRIAGERS = new Set([TRI]);

/** Words no Topic may carry. */
const SECRET = "Lunch with Pat about the merger";

/** The id the tests give the report named `name`: 32 hex characters. */
function idOf(name: string): string {
  return [...new TextEncoder().encode(name)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")
    .padEnd(32, "0").slice(0, 32);
}

/** A link to `topic` a triager wrote. */
function linkedTo(topic: string, by = TRI): Partial<Report> {
  return { topic, topicAuthors: [by] };
}

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

/** What a plan counts when it files nothing and leaves nothing out. */
const NOTHING = {
  file: [],
  update: [],
  untrusted: 0,
  unreadable: 0,
  untrustedLinks: 0,
  invalid: 0,
};

describe("triage", () => {
  describe("parseTrusted()", () => {
    it("returns one DID per line, without blanks or comments", () => {
      expect(parseTrusted(`${ADA}\n\n# the team\n  ${EVE} # alpha\n`))
        .toEqual(new Set([ADA, EVE]));
    });
  });

  describe("isTrusted()", () => {
    it("returns `true` only when every author is listed and one is named", () => {
      const a = (rest: Partial<Report>) => report("amber-fox-1", {}, rest);
      expect(isTrusted(a({}), TRUSTED)).toBe(true);
      expect(isTrusted(a({ authors: [EVE] }), TRUSTED)).toBe(false);
      expect(isTrusted(a({ authors: [ADA, EVE] }), TRUSTED)).toBe(false);
      expect(isTrusted(a({ authors: [] }), TRUSTED)).toBe(false);
      expect(isTrusted(a({ unreadable: true }), TRUSTED)).toBe(false);
    });
  });

  describe("titleOf() and sectionOf()", () => {
    it("returns a title and a marked section from the structured fields alone", () => {
      const reports = [report("quiet-heron-41"), report("calm-otter-7")];

      expect(titleOf(reports)).toBe(
        "[feedback] Weaver: auth-expired at gmail-sync",
      );
      const section = sectionOf(reports);
      expect(section.startsWith(`${SECTION_START}\nWhat is asked: Find`))
        .toBe(true);
      expect(section.endsWith(SECTION_END)).toBe(true);
      expect(section).toContain("- Reports: quiet-heron-41, calm-otter-7");
      expect(section).toContain("- Cause: auth-expired");
      expect(section).toContain("- Stop: gmail-sync");
      expect(section).toContain("- Retries: 2");
      expect(section).toContain("- CFS releases: 2026.11.18");
      expect(section).toContain("- Count: 2");
      expect(section).not.toContain("failed their checks");
    });

    it("never carries a report's words", () => {
      const reports = [report("amber-fox-1"), probeReport("brave-lynx-2")];

      expect(titleOf(reports)).not.toContain("Pat");
      expect(sectionOf(reports)).not.toContain("Pat");
      expect(commentOf([reports[0]], [probeReport("calm-otter-3", "1.2.3")]))
        .not.toContain("Pat");
    });

    it("shows a field that fails its shape as invalid, counts it, and groups nothing on it", () => {
      const bad = report("Not A Name", {
        cause: "[click](javascript:alert(1))",
        stop: "line\nbreak",
        release: "www.example.com",
      });
      const text = `${titleOf([bad])}\n${sectionOf([bad])}`;

      expect(text).not.toContain("javascript");
      expect(text).not.toContain("example");
      expect(text).not.toContain("Not A Name");
      expect(text).toContain(`- Reports: ${INVALID}`);
      expect(text).toContain("- Cause: unknown");
      expect(text).toContain("- Fields that failed their checks: 4");
      expect(titleOf([bad])).toBe("[feedback] Weaver: a problem");
      const plan = planTriage(
        [bad, { ...bad, id: idOf("b") }],
        TRUSTED,
        TRIAGERS,
      );
      expect(plan.file).toHaveLength(2);
      expect(plan.invalid).toBe(8);
    });

    it("titles a problem with no cause by its probe, and asks for a product call on a wish", () => {
      expect(titleOf([probeReport("amber-fox-1")])).toBe(
        "[feedback] gmail: probe token-valid fails",
      );
      const wish = report("amber-fox-2", {}, {
        kind: "wish",
        structured: { source: "report" },
      });
      expect(titleOf([wish])).toBe("[feedback] Weaver: a wish");
      expect(sectionOf([wish])).toContain("What is asked: Make a product call");
    });
  });

  describe("listed()", () => {
    it("returns at most the cap, then how many more", () => {
      const names = Array.from({ length: MAX_LISTED + 3 }, (_, i) => `n${i}`);

      expect(listed(names)).toBe(
        `${names.slice(0, MAX_LISTED).join(", ")}, +3 more`,
      );
      expect(listed(names.slice(0, MAX_LISTED))).not.toContain("more");
      expect(listed([])).toBe("unknown");
    });
  });

  describe("withSection()", () => {
    it("replaces only the marked section, keeping what people wrote around it", () => {
      const old = sectionOf([report("amber-fox-1")]);
      const fresh = sectionOf([report("amber-fox-1"), report("brave-lynx-2")]);
      const body = `Notes before.\n\n${old}\n\nOwner: Bo. Next: bisect.`;

      expect(withSection(body, fresh)).toBe(
        `Notes before.\n\n${fresh}\n\nOwner: Bo. Next: bisect.`,
      );
    });

    it("adds the section after a body that has none, and is the section for an empty one", () => {
      const section = sectionOf([report("amber-fox-1")]);

      expect(withSection("Hand-written.", section)).toBe(
        `Hand-written.\n\n${section}`,
      );
      expect(withSection("", section)).toBe(section);
      expect(withSection(`x ${SECTION_START} y`, section)).toBe(
        `x ${SECTION_START} y\n\n${section}`,
      );
    });
  });

  describe("planTriage()", () => {
    it("files one Topic for new reports sharing a cause and stop, and another for a different one", () => {
      const plan = planTriage(
        [
          report("amber-fox-1"),
          report("brave-lynx-2"),
          report("calm-otter-3", { cause: "rate-limited" }),
        ],
        TRUSTED,
        TRIAGERS,
      );

      expect(plan.file.map((filing) => filing.reports)).toEqual([
        [idOf("amber-fox-1"), idOf("brave-lynx-2")],
        [idOf("calm-otter-3")],
      ]);
      expect(plan.update).toEqual([]);
    });

    it("does not group reports sharing a cause with another stop", () => {
      const plan = planTriage(
        [report("amber-fox-1"), report("brave-lynx-2", { stop: "cal-sync" })],
        TRUSTED,
        TRIAGERS,
      );

      expect(plan.file).toHaveLength(2);
    });

    it("adds a new report to the Topic of a filed problem it matches, rewriting the section without a comment", () => {
      const filed = report("amber-fox-1", {}, linkedTo("of:fid1:topic-1"));
      const plan = planTriage(
        [filed, report("brave-lynx-2")],
        TRUSTED,
        TRIAGERS,
      );

      expect(plan.file).toEqual([]);
      expect(plan.update).toEqual([{
        topic: "of:fid1:topic-1",
        section: sectionOf([filed, report("brave-lynx-2")]),
        reports: [idOf("brave-lynx-2")],
      }]);
    });

    it("treats a link nobody on the triagers list wrote as no link, and counts it", () => {
      for (
        const link of [
          linkedTo("of:fid1:topic-1", EVE),
          { topic: "of:fid1:topic-1", topicAuthors: [] },
          { ...linkedTo("of:fid1:topic-1"), topicUnreadable: true as const },
          linkedTo("https://example.com/top/1"),
        ]
      ) {
        const plan = planTriage(
          [report("amber-fox-1", {}, link), report("brave-lynx-2")],
          TRUSTED,
          TRIAGERS,
        );

        expect(plan.update).toEqual([]);
        expect(plan.file.map((filing) => filing.reports)).toEqual([
          [idOf("amber-fox-1"), idOf("brave-lynx-2")],
        ]);
        expect(plan.untrustedLinks).toBe(1);
      }
    });

    it("comments when a new report brings a release or a stop the problem did not have", () => {
      const plan = planTriage(
        [
          probeReport("amber-fox-1"),
          report("pale-owl-9", {}, {
            ...linkedTo("of:fid1:topic-1"),
            structured: probeReport("pale-owl-9").structured,
          }),
          probeReport("brave-lynx-2", "2026.12.01"),
        ],
        TRUSTED,
        TRIAGERS,
      );

      expect(plan.update).toHaveLength(1);
      expect(plan.update[0].reports).toEqual([
        idOf("amber-fox-1"),
        idOf("brave-lynx-2"),
      ]);
      expect(plan.update[0].comment).toBe(
        "New reports: amber-fox-1, brave-lynx-2.\n" +
          "New CFS releases: 2026.12.01.\n3 reports now.",
      );
    });

    it("files nothing for an untrusted or unreadable sender, and only counts them", () => {
      const plan = planTriage(
        [
          report("amber-fox-1", {}, { authors: [EVE] }),
          report("brave-lynx-2", {}, { authors: [] }),
          report("calm-otter-3", {}, { unreadable: true, authors: [] }),
        ],
        TRUSTED,
        TRIAGERS,
      );

      expect(plan).toEqual({ ...NOTHING, untrusted: 2, unreadable: 1 });
    });

    it("does not let an untrusted report linked to a Topic decide what that problem is", () => {
      const plan = planTriage(
        [
          report("amber-fox-1", {}, {
            ...linkedTo("of:fid1:topic-1"),
            authors: [EVE],
          }),
          report("brave-lynx-2"),
        ],
        TRUSTED,
        TRIAGERS,
      );

      expect(plan.update).toEqual([]);
      expect(plan.file.map((filing) => filing.reports)).toEqual([
        [idOf("brave-lynx-2")],
      ]);
    });

    it("tells apart two reports sharing a name by their ids", () => {
      const ours = report("quiet-heron-41", {}, linkedTo("of:fid1:topic-1"));
      const theirs = report("quiet-heron-41", { cause: "rate-limited" }, {
        id: "f".repeat(32),
      });

      const plan = planTriage([ours, theirs], TRUSTED, TRIAGERS);

      expect(plan.update).toEqual([]);
      expect(plan.file.map((filing) => filing.reports)).toEqual([
        ["f".repeat(32)],
      ]);
    });

    it("leaves a report a triager linked alone", () => {
      const plan = planTriage(
        [report("amber-fox-1", {}, linkedTo("top/42"))],
        TRUSTED,
        TRIAGERS,
      );

      expect(plan).toEqual(NOTHING);
    });
  });
});

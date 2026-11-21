import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PatternIndexListedPattern } from "@commonfabric/pattern-index/client";
import { mineLines, mineRows } from "../lib/pattern-mine.ts";

const row = (
  fields: Partial<PatternIndexListedPattern> & { patternId: string },
): PatternIndexListedPattern => ({
  description: `about ${fields.patternId}`,
  hashtags: [],
  keywords: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  events: {},
  score: 0,
  mine: true,
  ...fields,
});

const noEntry = () => Promise.resolve(undefined);

describe("pattern-mine", () => {
  describe("mineRows()", () => {
    it("returns one row per lineage, for its newest version, counting versions", async () => {
      const rows = await mineRows([
        row({ patternId: "v1", lineageId: "v1", listing: "passed" }),
        row({
          patternId: "v2",
          lineageId: "v1",
          listing: "pending",
          createdAt: "2026-11-02T00:00:00.000Z",
        }),
        row({ patternId: "other", lineageId: "other", listing: "passed" }),
      ], noEntry);

      expect(rows.map((r) => [r.patternId, r.versions])).toEqual([
        ["v2", 2],
        ["other", 1],
      ]);
      expect(rows[0].next).toContain("checking");
    });

    it("returns a held pattern's failed gate findings and the command that republishes its entry file", async () => {
      const [held] = await mineRows([
        row({
          patternId: "h",
          listing: "held",
          gates: {
            privacy: {
              status: "failed",
              attempt: 1,
              findings: [{
                file: "/main.tsx",
                line: 3,
                category: "personal_name",
                why: "a person's name as a field",
              }],
            },
          },
        }),
      ], (id) => Promise.resolve(id === "h" ? "./bins.tsx" : undefined));

      expect(held.findings).toHaveLength(1);
      expect(held.next).toBe(
        "held: fix the findings, then run cf pattern share ./bins.tsx",
      );
      expect(mineLines([held]).join("\n")).toContain(
        "personal_name in /main.tsx:3",
      );
    });

    it("returns the republish command with an entry path a shell would split quoted", async () => {
      const [held] = await mineRows(
        [row({ patternId: "h", listing: "held" })],
        () => Promise.resolve("/work/my patterns/main.tsx"),
      );

      expect(held.next).toBe(
        "held: fix the findings, then run cf pattern share '/work/my patterns/main.tsx'",
      );
    });

    it("returns no findings for a held pattern whose gates passed", async () => {
      const [held] = await mineRows([
        row({
          patternId: "h",
          listing: "held",
          gates: { privacy: { status: "passed", attempt: 1, findings: [] } },
        }),
      ], noEntry);

      expect(held.findings).toBeUndefined();
    });

    it("returns bucket, counts, and what moves an unvetted pattern to Main", async () => {
      const [unvetted] = await mineRows([
        row({
          patternId: "u",
          listing: "passed",
          listed: true,
          bucket: "unvetted",
          aggregates: {
            deployed: { aggregate: "distinct_actors", value: 3 },
          },
        }),
      ], noEntry);

      expect(unvetted.bucket).toBe("unvetted");
      expect(unvetted.counts).toEqual({ deployed: 3 });
      expect(unvetted.next).toContain("/deploy index:u");
    });

    it("says an error waits for an admin re-run", async () => {
      const [failed] = await mineRows(
        [row({ patternId: "e", listing: "error" })],
        noEntry,
      );

      expect(failed.next).toContain("admin re-run");
    });

    it("leaves out rows the index marks as someone else's, or does not mark as the caller's", async () => {
      const { mine: _mine, ...unmarked } = row({ patternId: "y" });
      expect(
        await mineRows(
          [row({ patternId: "x", mine: false }), unmarked],
          noEntry,
        ),
      ).toEqual([]);
    });

    it("says what moves an unlisted, a listed-off, a Main, a featured and a plainly listed pattern on", async () => {
      const rows = await mineRows([
        row({ patternId: "n", listing: "not_requested" }),
        row({ patternId: "off", listing: "passed", listed: false }),
        row({ patternId: "m", listing: "passed", bucket: "main" }),
        row({ patternId: "f", listing: "passed", bucket: "featured" }),
        row({ patternId: "l", listing: "passed" }),
        row({ patternId: "b", listing: "passed", channel: "beta" }),
      ], noEntry);

      expect(Object.fromEntries(rows.map((r) => [r.patternId, r.next])))
        .toEqual({
          n: "not shared: run cf pattern share <entry file> to share it on beta, by link",
          off: "unlisted",
          m: "in Main: other people's use ranks it",
          f: "featured",
          l: "listed",
          b: "on beta, by link only: cf pattern stable <entry file> makes it findable",
        });
    });
  });

  describe("mineLines()", () => {
    it("returns where to start for no patterns", () => {
      expect(mineLines([])).toEqual([
        "You have shared no patterns. Start with: cf pattern share <entry file>",
      ]);
    });

    it("returns a row's name, versions, next step and use counts, and no counts line for none", () => {
      expect(mineLines([
        {
          patternId: "p2",
          lineageId: "p1",
          versions: 2,
          name: "Bin day",
          description: "about bins",
          counts: { deployed: 3, opened: 5 },
          next: "listed",
        },
        {
          patternId: "q",
          lineageId: "q",
          versions: 1,
          description: "about q",
          counts: {},
          next: "featured",
        },
      ])).toEqual([
        "Bin day  p2 (2 versions)",
        "  listed",
        "  deployed: 3, opened: 5",
        "about q  q",
        "  featured",
      ]);
    });
  });
});

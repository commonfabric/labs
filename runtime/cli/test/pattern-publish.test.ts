import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { PatternIndexClient } from "@commonfabric/pattern-index/client";
import type { ObjectGenerator } from "@commonfabric/pattern-index/privacy";
import type { CompiledPattern } from "@commonfabric/pattern-index/publish";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  type PublishDeps,
  PublishError,
  publishPatternFromDisk,
  type PublishReport,
  publishReportLines,
} from "../lib/pattern-publish.ts";
import { PatternIndexStore } from "@commonfabric/pattern-index/store";
import { FakePatternIndex } from "../../pattern-index/test/fake-pattern-index.ts";

const ADDRESS = "742 Evergreen Terrace";
const signer = await Identity.fromPassphrase("pattern publish test");

const SOURCE = `/**
 * Reminds the household to take the bins out on collection day.
 *
 * @hashtags #Chores, bins
 * @keywords bin day, recycling
 */
const HOME = "${ADDRESS}";
export default () => HOME;
`;

const GENERALIZED = `/**
 * Reminds the household to take the bins out on collection day.
 *
 * @hashtags #Chores, bins
 * @keywords bin day, recycling
 */
export default (home: string) => home;
`;

const PRIVACY_PROMPT = {
  name: "privacy",
  kind: "gate",
  promptVersion: "v1",
  prompt: "PRIVACY",
  outputSchema: { type: "object" },
};

const PASS = { verdict: "pass", findings: [], generalizations: [] };
const FAIL = {
  verdict: "fail",
  findings: [{
    file: "/bins.tsx",
    line: 7,
    category: "address_or_location",
    why: "a street address in a constant",
  }],
  generalizations: [{
    finding: 0,
    category: "lift_constant_to_argument",
    suggestion: "lift HOME into an argument named home",
  }],
};
const REWRITE = {
  files: [{ name: "/bins.tsx", contents: GENERALIZED }],
  changes: [{ file: "/bins.tsx", category: "lift_constant_to_argument" }],
};

/** A model answering checks and rewrites from scripts, by system prompt. */
const scripted =
  (checks: unknown[], rewrites: unknown[]): ObjectGenerator => (request) => {
    const next = request.system === "PRIVACY"
      ? checks.shift()
      : rewrites.shift();
    return next === undefined
      ? Promise.reject(new Error("unscripted model call"))
      : Promise.resolve(next);
  };

/** A compile whose id is the entry's contents, so a rewrite changes it. */
const compiledFrom = (program: RuntimeProgram): CompiledPattern => ({
  patternId: `id-${
    program.files[0].contents.includes(ADDRESS) ? "original" : "generalized"
  }`,
  program,
});

/** Publishes, failing the test on a blocked outcome. */
const publishedReport = async (
  ...args: Parameters<typeof publishPatternFromDisk>
): Promise<Extract<PublishReport, { outcome: "shared" }>> => {
  const report = await publishPatternFromDisk(...args);
  if (report.outcome !== "shared") {
    throw new Error(`blocked: ${report.next}`);
  }
  return report;
};

describe("pattern-publish", () => {
  let dir: string;
  let entry: string;
  let index: FakePatternIndex;
  let store: PatternIndexStore;
  let written: Map<string, string>;
  let dirty: string[] | undefined;

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    entry = join(dir, "bins.tsx");
    await Deno.writeTextFile(entry, SOURCE);
    store = new PatternIndexStore(join(dir, "store"));
    index = new FakePatternIndex({ privacyPrompt: PRIVACY_PROMPT });
    index.admit(signer.did(), "p-me");
    written = new Map();
    dirty = [];
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  const depsWith = (
    generate: ObjectGenerator | undefined,
  ): PublishDeps => ({
    compileEntry: async (path) =>
      compiledFrom({
        main: "/bins.tsx",
        files: [{ name: "/bins.tsx", contents: await Deno.readTextFile(path) }],
      }),
    compileProgram: (program) => Promise.resolve(compiledFrom(program)),
    client: new PatternIndexClient({
      baseUrl: "https://index.test",
      signer,
      fetchFn: index.fetchFn,
    }),
    generate,
    modelLabel: "https://toolshed.test",
    uncommitted: () => Promise.resolve(dirty),
    readTextFile: (path) => Deno.readTextFile(path),
    writeTextFile: async (path, contents) => {
      written.set(path, contents);
      await Deno.writeTextFile(path, contents);
    },
    store,
  });

  describe("publishPatternFromDisk()", () => {
    it("rewrites a pattern holding a street address, writes it back on a clean tree, publishes it and requests a listing", async () => {
      const report = await publishedReport(
        { entry },
        depsWith(scripted([FAIL, PASS], [REWRITE])),
      );

      expect(report.localCheck).toMatchObject({
        status: "rewritten",
        applied: true,
        changes: REWRITE.changes,
      });
      expect(await Deno.readTextFile(entry)).toBe(GENERALIZED);
      expect(report.patternId).toBe("id-generalized");
      expect(report.listing).toEqual({
        status: "requested",
        listing: "pending",
      });
      expect(report.handle).toBe("p-me");
      expect(report.next).toContain("/deploy index:id-generalized");
      const publish = index.calls.find((call) => call.fn === "publishPattern")!;
      expect(JSON.stringify(publish.body)).not.toContain(ADDRESS);
      expect(publish.body).not.toHaveProperty("directQuery");
      expect((publish.body.meta as Record<string, unknown>).directQuery)
        .toBeUndefined();
      expect(publish.body.meta).toMatchObject({
        description:
          "Reminds the household to take the bins out on collection day.",
        hashtags: ["chores", "bins"],
        keywords: ["bin day", "recycling"],
      });
    });

    it("never prints or reports the value a finding is about", async () => {
      const report = await publishedReport(
        { entry },
        depsWith(scripted([FAIL, PASS], [REWRITE])),
      );

      expect(JSON.stringify(report)).not.toContain(ADDRESS);
      expect(publishReportLines(report).join("\n")).not.toContain(ADDRESS);
      expect(publishReportLines(report).join("\n")).toContain("git diff");
    });

    it("publishes nothing and leaves the file alone when it has uncommitted edits", async () => {
      dirty = [entry];
      const report = await publishPatternFromDisk(
        { entry },
        depsWith(scripted([FAIL, PASS], [REWRITE])),
      );

      expect(report.outcome).toBe("blocked");
      expect(report.localCheck).toMatchObject({
        status: "rewritten",
        applied: false,
      });
      expect(written.size).toBe(0);
      expect(await Deno.readTextFile(entry)).toBe(SOURCE);
      expect(index.calls.some((call) => call.fn === "publishPattern")).toBe(
        false,
      );
      expect(publishReportLines(report).join("\n")).toContain(
        "Nothing was shared",
      );
    });

    it("writes the rewrite over uncommitted edits with allowDirty", async () => {
      dirty = [entry];
      const report = await publishedReport(
        { entry, allowDirty: true },
        depsWith(scripted([FAIL, PASS], [REWRITE])),
      );

      expect(report.localCheck).toMatchObject({ applied: true });
      expect(await Deno.readTextFile(entry)).toBe(GENERALIZED);
    });

    it("publishes nothing and writes nothing outside a git working tree", async () => {
      dirty = undefined;
      const report = await publishPatternFromDisk(
        { entry },
        depsWith(scripted([FAIL, PASS], [REWRITE])),
      );

      expect(report.outcome).toBe("blocked");
      expect(written.size).toBe(0);
      expect(index.calls.some((call) => call.fn === "publishPattern")).toBe(
        false,
      );
    });

    it("keeps the source as a private version, then writes the rewrite, outside a git working tree when it has a lineage", async () => {
      dirty = undefined;
      const report = await publishedReport(
        { entry, slot: "cf-path:abc" },
        depsWith(scripted([FAIL, PASS], [REWRITE])),
      );

      expect(report.localCheck).toMatchObject({
        status: "rewritten",
        applied: true,
        originalVersion: 1,
      });
      expect(await Deno.readTextFile(entry)).toBe(GENERALIZED);
      const publishes = index.calls.filter((c) => c.fn === "publishPattern");
      // No version is marked keepPrivate: a publish never shares by itself,
      // and the mark would keep a deployed head from ever sharing.
      expect(publishes.map((c) => [c.body.patternId, c.body.keepPrivate]))
        .toEqual([["id-original", undefined], ["id-generalized", undefined]]);
      expect(publishes.every((c) => c.body.slot === "cf-path:abc")).toBe(true);
      expect(publishes.every((c) => c.body.origin === "self")).toBe(true);
      expect(report.version).toBe(2);
      const lines = publishReportLines(report).join("\n");
      expect(lines).toContain("kept as v1; cf pattern rollback restores it");
      expect(lines).toContain("(v2)");
    });

    it("credits a remix on the version that starts the lineage, and not on a lineage already started", async () => {
      dirty = undefined;
      await store.recordSource([entry], "pat-theirs");
      const first = await publishedReport(
        { entry, slot: "cf-path:remix" },
        depsWith(scripted([FAIL, PASS], [REWRITE])),
      );

      const publishes = index.calls.filter((c) => c.fn === "publishPattern");
      expect(publishes.map((c) => c.body.remixedFrom)).toEqual([
        "pat-theirs",
        undefined,
      ]);
      expect(first.remixedFrom).toBe("pat-theirs");
    });

    it("throws naming cf index join, before compiling, for an identity that is no member", async () => {
      index = new FakePatternIndex({ privacyPrompt: PRIVACY_PROMPT });
      let compiled = false;
      const deps = depsWith(undefined);
      await expect(publishPatternFromDisk({ entry }, {
        ...deps,
        compileEntry: (...args) => {
          compiled = true;
          return deps.compileEntry(...args);
        },
      })).rejects.toThrow("cf index join");
      expect(compiled).toBe(false);
    });

    it("still publishes, and requests the listing, when both rewrites fail, showing the findings", async () => {
      const report = await publishedReport(
        { entry },
        depsWith(scripted([FAIL, FAIL, FAIL], [REWRITE, REWRITE])),
      );

      expect(report.localCheck).toMatchObject({
        status: "held",
        findings: FAIL.findings,
      });
      expect(report.patternId).toBe("id-original");
      expect(report.listing.status).toBe("requested");
      expect(written.size).toBe(0);
      expect(publishReportLines(report).join("\n")).toContain(
        "address_or_location in /bins.tsx:7",
      );
    });

    it("skips the local check and says so in one line when no LLM is configured", async () => {
      const report = await publishedReport(
        { entry },
        depsWith(undefined),
      );

      expect(report.localCheck).toEqual({
        status: "skipped",
        reason: "no LLM is configured for cf",
      });
      expect(index.calls.some((call) => call.fn === "getGardenerPrompt"))
        .toBe(false);
      expect(report.listing.status).toBe("requested");
      expect(
        publishReportLines(report).filter((line) => line.includes("Skipped")),
      ).toHaveLength(1);
    });

    it("skips the local check when the model does not answer", async () => {
      const report = await publishedReport(
        { entry },
        depsWith(() => Promise.reject(new Error("HTTP 503"))),
      );

      expect(report.localCheck).toMatchObject({ status: "skipped" });
      expect(report.patternId).toBe("id-original");
    });

    it("names the previous id published from the same entry file as the prior version", async () => {
      await publishedReport({ entry }, depsWith(scripted([PASS], [])));
      await Deno.writeTextFile(entry, GENERALIZED);
      const report = await publishedReport(
        { entry },
        depsWith(scripted([PASS], [])),
      );

      expect(report.priorPatternId).toBe("id-original");
      const second = index.calls.filter((call) => call.fn === "publishPattern")
        .at(-1)!;
      expect(second.body.priorPatternId).toBe("id-original");
    });

    it("credits the pattern the source was fetched from as remixedFrom", async () => {
      const someoneElse = await Identity.fromPassphrase(
        "pattern publish other",
      );
      index.admit(someoneElse.did(), "p-other");
      await new PatternIndexClient({
        baseUrl: "https://index.test",
        signer: someoneElse,
        fetchFn: index.fetchFn,
      }).publishPattern({
        patternId: "id-theirs",
        description: "theirs",
        hashtags: [],
        program: { main: "/x.tsx", files: [] },
      });
      await store.recordSource([entry], "id-theirs");
      const report = await publishedReport(
        { entry },
        depsWith(scripted([PASS], [])),
      );

      expect(report.remixedFrom).toBe("id-theirs");
      expect(report.priorPatternId).toBeUndefined();
    });

    it("names one's own pattern the source was fetched from as the prior version, not a remix", async () => {
      await new PatternIndexClient({
        baseUrl: "https://index.test",
        signer,
        fetchFn: index.fetchFn,
      }).publishPattern({
        patternId: "id-mine-earlier",
        description: "mine",
        hashtags: [],
        program: { main: "/x.tsx", files: [] },
      });
      await store.recordSource([entry], "id-mine-earlier");
      const report = await publishedReport(
        { entry },
        depsWith(scripted([PASS], [])),
      );

      expect(report.priorPatternId).toBe("id-mine-earlier");
      expect(report.remixedFrom).toBeUndefined();
    });

    it("names no remix for source published unchanged from the pattern it was fetched from", async () => {
      await store.recordSource([entry], "id-original");
      const report = await publishedReport(
        { entry },
        depsWith(scripted([PASS], [])),
      );

      expect(report.remixedFrom).toBeUndefined();
      const publish = index.calls.find((call) => call.fn === "publishPattern")!;
      expect(publish.body).not.toHaveProperty("remixedFrom");
    });

    it("credits no remix to a new file beside one fetched from a published pattern", async () => {
      await store.recordSource([join(dir, "fetched.tsx")], "id-theirs");
      const report = await publishedReport(
        { entry },
        depsWith(scripted([PASS], [])),
      );

      expect(report.remixedFrom).toBeUndefined();
    });

    it("names no predecessor after an unchanged copy of someone else's pattern is published and then edited", async () => {
      const someoneElse = await Identity.fromPassphrase(
        "pattern publish other",
      );
      index.admit(someoneElse.did(), "p-other");
      await new PatternIndexClient({
        baseUrl: "https://index.test",
        signer: someoneElse,
        fetchFn: index.fetchFn,
      }).publishPattern({
        patternId: "id-original",
        description: "theirs",
        hashtags: [],
        program: { main: "/x.tsx", files: [] },
      });
      await store.recordSource([entry], "id-original");
      const unchanged = await publishedReport(
        { entry },
        depsWith(scripted([PASS], [])),
      );
      expect(unchanged.created).toBe(false);

      await Deno.writeTextFile(entry, GENERALIZED);
      await store.recordSource([entry], "id-original");
      const edited = await publishedReport(
        { entry },
        depsWith(scripted([PASS], [])),
      );

      expect(edited.priorPatternId).toBeUndefined();
      expect(edited.remixedFrom).toBe("id-original");
    });

    it("writes nothing and publishes nothing when the file changed on disk during the check", async () => {
      const deps = depsWith(scripted([FAIL, PASS], [REWRITE]));
      const report = await publishPatternFromDisk({ entry }, {
        ...deps,
        compileProgram: async (program) => {
          // The person's agent edits the file while the model is working.
          await Deno.writeTextFile(entry, `${SOURCE}// edited\n`);
          return deps.compileProgram(program);
        },
      });

      expect(report.outcome).toBe("blocked");
      expect(written.size).toBe(0);
      expect(await Deno.readTextFile(entry)).toBe(`${SOURCE}// edited\n`);
    });

    it("skips the local check for a prompt whose input format this cf does not write", async () => {
      index = new FakePatternIndex({
        privacyPrompt: { ...PRIVACY_PROMPT, inputFormat: "pattern-json-2" },
      });
      index.admit(signer.did(), "p-me");
      const report = await publishedReport(
        { entry },
        depsWith(scripted([FAIL], [])),
      );

      expect(report.localCheck).toMatchObject({ status: "skipped" });
      if (report.localCheck.status !== "skipped") return;
      expect(report.localCheck.reason).toContain("pattern-json-2");
    });

    it("compiles with the tests and data files under their common directory, as cf piece new does", async () => {
      await Deno.mkdir(join(dir, "tests"));
      const test = join(dir, "tests", "bins.test.tsx");
      const deps = depsWith(undefined);
      let seen: Parameters<PublishDeps["compileEntry"]>[1] | undefined;
      await publishedReport({ entry, testPaths: [test], mainExport: "Bins" }, {
        ...deps,
        compileEntry: (path, program) => {
          seen = program;
          return deps.compileEntry(path, program);
        },
      });

      expect(seen).toEqual({
        root: dir,
        testPaths: [test],
        dataFilePaths: [],
        mainExport: "Bins",
      });
    });

    it("reads the daily cap as when to try again, having published", async () => {
      index = new FakePatternIndex({
        privacyPrompt: PRIVACY_PROMPT,
        capResetsAt: "2026-11-16T00:00:00.000Z",
      });
      index.admit(signer.did(), "p-me");
      const report = await publishedReport(
        { entry },
        depsWith(scripted([PASS], [])),
      );

      expect(report.created).toBe(true);
      expect(report.listing).toEqual({
        status: "capped",
        resetsAt: "2026-11-16T00:00:00.000Z",
      });
      expect(publishReportLines(report).join("\n")).toContain(
        "2026-11-16T00:00:00.000Z",
      );
    });

    it("throws before compiling anything for an entry with no description", async () => {
      await Deno.writeTextFile(entry, "export default 1;\n");
      await expect(
        publishPatternFromDisk({ entry }, depsWith(undefined)),
      ).rejects.toThrow(PublishError);
      expect(index.calls).toHaveLength(0);
    });
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { exists } from "@std/fs/exists";
import { Identity } from "@commonfabric/identity";
import {
  collectVintages,
  relativeToRepo,
  reportCaptureRefusedOnRed,
  reportDropsApplied,
  reportEmptyReplay,
  reportEveryGenerationCurrent,
  reportOnlyWithCapture,
  reportPinNeedsOneTestKey,
  reportUnknownFlags,
  reportUpdateNeedsATestKey,
} from "./pattern-vintage-lib.ts";
import type { GateRoots } from "./pattern-vintage-run.ts";
import type { AcceptedStateDrop } from "./pattern-vintage-accepted-drops.ts";
import { runPatternVintage } from "./pattern-vintage.ts";

const signer = await Identity.fromPassphrase("pattern vintage shell test");

const KEY = "vintage-shell-subject.tsx";

const TEST_KEY = "vintage-shell-subject.test.tsx";

/** The subject's route, so the gate requires a fixture covering it. */
const SUBJECT_URL = `https://example.com/api/patterns/${KEY}`;

const SUBJECT = [
  "import { pattern, Writable } from 'commonfabric';",
  "export interface Output { items: Writable<string[]> }",
  "export default pattern<Record<string, never>, Output>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  return { items };",
  "});",
  "",
].join("\n");

/** `SUBJECT` with its items stored under another name, stranding the old. */
const MOVED = SUBJECT.replace(".for('items')", ".for('itemList')");

const SUBJECT_TEST = [
  "import { action, assert, pattern, TESTS } from 'commonfabric';",
  `import Subject from './${KEY}';`,
  "export default pattern(() => {",
  "  const subject = Subject({});",
  "  const add = action(() => {",
  "    subject.items.set([...subject.items.get(), 'captured']);",
  "  });",
  "  const added = assert(() => subject.items.get().length === 1);",
  "  return { [TESTS]: [{ action: add }, { assertion: added }], subject };",
  "});",
  "",
].join("\n");

/** `SUBJECT` grown a field, which every vintage of it can still be read by. */
const GROWN = SUBJECT
  .replace(
    "export interface Output { items: Writable<string[]> }",
    "export interface Output { items: Writable<string[]>; note: Writable<string> }",
  )
  .replace(
    "  return { items };",
    "  const note = new Writable<string>('n').for('note');\n  return { items, note };",
  );

/** A test whose assertion never holds, which a capture refuses. */
const FAILING_TEST = SUBJECT_TEST.replace("length === 1", "length === 2");

/**
 * A subject whose `rows` come from a map, so a capture records the hoisted
 * pattern the map instantiates beside the default export.
 */
const MAPPED = [
  "import { pattern, Writable } from 'commonfabric';",
  "interface RowOut { shout: string }",
  "export const Row = pattern<{ word: string }, RowOut>(({ word }) => {",
  "  return { shout: word };",
  "});",
  "export interface Output { items: Writable<string[]>; rows: RowOut[] }",
  "export default pattern<Record<string, never>, Output>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const rows = items.map((word) => Row({ word }));",
  "  return { items, rows };",
  "});",
  "",
].join("\n");

/** `MAPPED` with the map unrolled, so today's module emits no hoist. */
const UNROLLED = MAPPED
  .replace(
    "import { pattern, Writable } from 'commonfabric';",
    "import { computed, pattern, Writable } from 'commonfabric';",
  )
  .replace(
    "  const rows = items.map((word) => Row({ word }));",
    "  const rows = computed(() =>\n" +
      "    items.get().map((word) => ({ shout: word }))\n" +
      "  );",
  );

/** `SUBJECT_TEST`, reading `rows` so the map runs and its rows instantiate. */
const MAPPED_TEST = SUBJECT_TEST.replace(
  "  return {",
  "  const mapped = assert(() => subject.rows.length === 1);\n  return {",
).replace(
  "{ assertion: added }]",
  "{ assertion: added }, { assertion: mapped }]",
);

const drop = (
  pattern: string,
  paths: readonly string[],
): AcceptedStateDrop => ({
  pattern,
  paths,
  capturedThrough: "2099-01-01T00-00-00.000Z",
  reason: "the items moved on purpose",
  record: "docs/history/vintage-shell-items-moved.md",
});

describe("pattern-vintage", () => {
  let dir = "";
  let roots: GateRoots;
  let progress: string[] = [];

  beforeEach(async () => {
    progress = [];
    dir = await Deno.makeTempDir({ prefix: "vintage-shell-" });
    await Deno.mkdir(`${dir}/patterns`, { recursive: true });
    roots = {
      repoRoot: dir,
      patternsRoot: `${dir}/patterns`,
      vintagesRoot: `${dir}/vintages`,
      signer,
    };
    await Deno.writeTextFile(`${dir}/patterns/${KEY}`, SUBJECT);
    await Deno.writeTextFile(`${dir}/patterns/${TEST_KEY}`, SUBJECT_TEST);
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  /**
   * Run the shell over the temporary tree, requiring only the subject, and
   * collect its progress lines into `progress`.
   */
  const run = (
    args: readonly string[],
    acceptedDrops: readonly AcceptedStateDrop[] = [],
  ) =>
    runPatternVintage(args, {
      roots,
      systemPatternUrls: [SUBJECT_URL],
      acceptedDrops,
      progress: (line) => progress.push(line),
    });

  /** The progress lines that announce a capture. */
  const captureLines = () =>
    progress.filter((line) => line.startsWith("capture "));

  describe("runPatternVintage()", () => {
    describe("a run refused before any replay", () => {
      it("returns the unknown-flag report for a flag it does not know", async () => {
        expect(await run(["--frobnicate"])).toEqual({
          err: reportUnknownFlags(["--frobnicate"]),
          code: 1,
        });
      });

      it("returns the scope report for `--only` beside a capture", async () => {
        expect(await run(["--only", "x", "--update", TEST_KEY])).toEqual({
          err: reportOnlyWithCapture(),
          code: 1,
        });
      });

      it("returns the unmapped-URL report for a system pattern URL naming no pattern", async () => {
        const shown = await runPatternVintage([], {
          roots,
          systemPatternUrls: ["https://example.com/not-a-pattern.tsx"],
        });

        expect(shown.code).toBe(1);
        expect(shown.err).toContain("https://example.com/not-a-pattern.tsx");
      });

      it("returns the needs-a-test report for `--update` naming nothing", async () => {
        expect(await run(["--update"])).toEqual({
          err: reportUpdateNeedsATestKey(),
          code: 1,
        });
      });

      it("returns the needs-one-key report for `--pin` naming nothing", async () => {
        const shown = await run(["--pin"]);

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(reportPinNeedsOneTestKey(0));
      });
    });

    describe("`--update`", () => {
      it("captures a vintage for the named test, then reports it already pinned", async () => {
        const captured = await run(["--update", TEST_KEY, TEST_KEY]);

        expect(progress).toEqual([`capture 1/1: ${TEST_KEY}`]);

        expect(captured.err).toBeUndefined();
        expect(captured.code).toBe(0);
        const [vintage] = await collectVintages(roots.vintagesRoot);
        expect(vintage.testKey).toBe(TEST_KEY);
        expect(captured.out).toBe(
          `  + ${vintage.path.slice(dir.length + 1)}`,
        );

        progress = [];
        expect(await run(["--update", TEST_KEY])).toEqual({
          out: `Already pinned: ${TEST_KEY}.`,
          code: 0,
        });
        expect(progress).toEqual([]);
      });

      it("fails, naming the problem, when the named test does not pass", async () => {
        await Deno.writeTextFile(`${dir}/patterns/${TEST_KEY}`, FAILING_TEST);
        const shown = await run(["--update", TEST_KEY]);

        expect(progress).toEqual([`capture 1/1: ${TEST_KEY}`]);
        expect(shown.code).toBe(1);
        expect(shown.out).toBeUndefined();
        expect(shown.err).toMatch(/^\n1 vintage\(s\) could not be captured:\n/);
        expect(await collectVintages(roots.vintagesRoot)).toEqual([]);
      });
    });

    describe("the plain gate", () => {
      it("passes with the replay summary when today's source reads every vintage", async () => {
        await run(["--update", TEST_KEY]);
        const shown = await run([]);

        expect(shown.err).toBeUndefined();
        expect(shown.code).toBe(0);
        expect(shown.out).toMatch(/^Replayed 1 vintage\(s\): /);
      });

      it("hands the caller a line as its fixture and each target begins", async () => {
        await run(["--update", TEST_KEY]);
        const [vintage] = await collectVintages(roots.vintagesRoot);
        progress = [];

        expect((await run([])).code).toBe(0);

        expect(progress[0]).toBe(
          `fixture 1/1: ${relativeToRepo(vintage.path, dir)}`,
        );
        expect(progress.slice(1)).not.toEqual([]);
        expect(progress.slice(1)).toEqual(
          progress.slice(1).map((_, index) =>
            expect.stringMatching(
              new RegExp(`^  target ${index + 1}/${progress.length - 1}: `),
            )
          ),
        );
      });

      it("fails, naming the uncovered pattern, when nothing was replayed", async () => {
        const shown = await run([]);

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(KEY);
        expect(shown.err).toContain(`\n${reportEmptyReplay([])}`);
        expect(shown.out).toBeUndefined();
      });

      it("reports a filtered run that matched nothing without judging coverage", async () => {
        const shown = await run(["--only", "no-such-fixture"]);

        expect(shown.code).toBe(1);
        expect(shown.err).toBe(`\n${reportEmptyReplay(["no-such-fixture"])}`);
      });

      it("reports a recorded hoist today's source no longer emits, and passes", async () => {
        await Deno.writeTextFile(`${dir}/patterns/${KEY}`, MAPPED);
        await Deno.writeTextFile(`${dir}/patterns/${TEST_KEY}`, MAPPED_TEST);
        await run(["--update", TEST_KEY]);
        await Deno.writeTextFile(`${dir}/patterns/${KEY}`, UNROLLED);
        const shown = await run([]);

        expect(shown.err).toBeUndefined();
        expect(shown.code).toBe(0);
        expect(shown.out).toMatch(
          /__cfPattern_[1-9]\d* \(hoist no longer emitted\)/,
        );
        expect(shown.out).toMatch(/\nReplayed 1 vintage\(s\): /);
      });

      it("fails when today's source strands state a vintage held", async () => {
        await run(["--update", TEST_KEY]);
        await Deno.writeTextFile(`${dir}/patterns/${KEY}`, MOVED);
        const shown = await run([]);

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(TEST_KEY);
        expect(shown.err).toContain("items");
      });

      it("reports an accepted removal it applied, and fails one that forgives nothing", async () => {
        await run(["--update", TEST_KEY]);
        await Deno.writeTextFile(`${dir}/patterns/${KEY}`, MOVED);
        const shown = await run([], [drop(KEY, ["items", "unrelated"])]);

        expect(shown.code).toBe(1);
        expect(shown.out).toBe(`\n${reportDropsApplied([`${KEY} items`])}`);
        expect(shown.err).toContain(
          "\n1 accepted removal path(s) in " +
            "tasks/pattern-vintage-accepted-drops.ts forgive nothing: ",
        );
        expect(shown.err).toContain("unrelated");
      });

      it("fails an accepted removal naming a pattern no fixture records", async () => {
        await run(["--update", TEST_KEY]);
        const shown = await run([], [drop("elsewhere/gone.tsx", ["items"])]);

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(
          "\n1 accepted removal(s) in tasks/pattern-vintage-accepted-drops.ts " +
            "name a pattern no fixture records: elsewhere/gone.tsx.",
        );
      });
    });

    describe("`--capture-changed` and `--pin`", () => {
      it("captures nothing when every generation is current", async () => {
        await run(["--update", TEST_KEY]);
        progress = [];
        const shown = await run(["--capture-changed"]);

        expect(shown).toEqual({
          out: reportEveryGenerationCurrent(1),
          code: 0,
        });
        expect(progress[0]).toMatch(/^fixture 1\/1: /);
        expect(captureLines()).toEqual([]);
        expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
      });

      it("refuses to capture while a vintage fails to replay", async () => {
        await run(["--update", TEST_KEY]);
        await Deno.writeTextFile(`${dir}/patterns/${KEY}`, MOVED);
        const shown = await run(["--capture-changed"]);

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(reportCaptureRefusedOnRed(1));
        expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
      });

      /** Capture an auto generation over a moved source; return its path. */
      const captureGeneration = async () => {
        await run(["--update", TEST_KEY]);
        await Deno.writeTextFile(`${dir}/patterns/${KEY}`, GROWN);
        progress = [];
        const captured = await run(["--capture-changed"]);
        expect(captureLines()).toEqual([`capture 1/1: ${TEST_KEY}`]);
        expect(captured.err).toBeUndefined();
        expect(captured.code).toBe(0);
        const auto = (await collectVintages(roots.vintagesRoot))
          .map((vintage) => vintage.path.slice(dir.length + 1))
          .filter((path) => path.includes("/auto/"));
        expect(auto).toHaveLength(1);
        expect(captured.out).toBe(`  + ${auto[0]}`);
        return auto[0];
      };

      it("captures a generation once the source moves, which `--pin` then promotes", async () => {
        const auto = await captureGeneration();
        const pinned = auto.replace("/auto/", "/pinned/");

        expect(await run(["--pin", TEST_KEY])).toEqual({
          out: `  ${auto}\n  → ${pinned}`,
          code: 0,
        });
        expect(await exists(`${dir}/${pinned}`)).toBe(true);
        expect(await exists(`${dir}/${auto}`)).toBe(false);
      });

      it("refuses to promote a generation onto an existing pinned vintage", async () => {
        const auto = await captureGeneration();
        const pinned = auto.replace("/auto/", "/pinned/");
        await Deno.writeTextFile(`${dir}/${pinned}`, "");

        const shown = await run(["--pin", TEST_KEY]);
        expect(shown.code).toBe(1);
        expect(shown.err).toContain(`Could not promote ${auto}: `);
        expect(shown.err).toContain("already exists");
        expect(await exists(`${dir}/${auto}`)).toBe(true);
      });

      it("reports a generation whose test no longer passes as not captured", async () => {
        await run(["--update", TEST_KEY]);
        await Deno.writeTextFile(`${dir}/patterns/${KEY}`, GROWN);
        await Deno.writeTextFile(`${dir}/patterns/${TEST_KEY}`, FAILING_TEST);
        const shown = await run(["--capture-changed"]);

        expect(shown.code).toBe(1);
        expect(shown.out).toBeUndefined();
        expect(shown.err).toMatch(
          new RegExp(
            `^\\n1 generation\\(s\\) were not captured:\\n  ${TEST_KEY}: `,
          ),
        );
      });
    });
  });
});

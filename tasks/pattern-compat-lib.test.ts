import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type JSONSchema } from "@commonfabric/runner";
import {
  acceptedBreakKey,
  type Baseline,
  baselineFileName,
  checkPattern,
  contractHash,
  decodeBaseline,
  encodeBaseline,
  type Finding,
  incompatibilityPaths,
  parseArgs,
  partitionAcceptedBreaks,
  type PatternContract,
  readBaselines,
  selectItems,
  shouldRecord,
  writeBaseline,
} from "./pattern-compat-lib.ts";
import {
  collectBaselineKeys,
  collectCompatibilityPaths,
} from "./pattern-files.ts";

const contract = (
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
): PatternContract => ({ argumentSchema, resultSchema });

const baseline = (
  label: string,
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
): Baseline => ({ label, contract: contract(argumentSchema, resultSchema) });

const EMPTY_ARGUMENT: JSONSchema = { type: "object", properties: {} };

const RESULT_WITH_TITLE: JSONSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
};

/** The same contract, with `title` dropped from the result. */
const RESULT_WITHOUT_TITLE: JSONSchema = {
  type: "object",
  properties: {},
};

describe("checkPattern", () => {
  it("rejects a result schema that drops a previously promised field", () => {
    const current = contract(EMPTY_ARGUMENT, RESULT_WITHOUT_TITLE);
    const findings = checkPattern("system/home.tsx", current, [
      baseline("v1", EMPTY_ARGUMENT, RESULT_WITH_TITLE),
    ]);

    const incompatible = findings.filter((f) => f.kind === "incompatible");
    expect(incompatible.length).toBe(1);
    expect(incompatible[0]).toMatchObject({
      kind: "incompatible",
      pattern: "system/home.tsx",
      baseline: "v1",
    });
  });

  it("reports a missing baseline for a contract no file records", () => {
    const current = contract(EMPTY_ARGUMENT, RESULT_WITH_TITLE);
    const findings = checkPattern("system/home.tsx", current, []);

    expect(findings).toEqual([{
      kind: "missing-baseline",
      pattern: "system/home.tsx",
      hash: contractHash(current),
    }]);
  });

  it("passes a contract that is recorded and compatible with every baseline", () => {
    const current = contract(EMPTY_ARGUMENT, RESULT_WITH_TITLE);
    const findings = checkPattern("system/home.tsx", current, [
      baseline("v1", EMPTY_ARGUMENT, RESULT_WITH_TITLE),
    ]);

    expect(findings).toEqual([]);
  });

  it("checks against every baseline, not just the newest", () => {
    // v2 dropped `title` behind a declared break; v3 must still be proven
    // against v1, which is what a piece that has not opened since v1 holds.
    const current = contract(EMPTY_ARGUMENT, RESULT_WITHOUT_TITLE);
    const findings = checkPattern("system/home.tsx", current, [
      baseline("v1", EMPTY_ARGUMENT, RESULT_WITH_TITLE),
      baseline("v2", EMPTY_ARGUMENT, RESULT_WITHOUT_TITLE),
    ]);

    const incompatible = findings.filter((f) => f.kind === "incompatible");
    expect(incompatible.length).toBe(1);
    expect(incompatible[0]).toMatchObject({ baseline: "v1" });
  });

  it("reports a malformed schema on a contract that is not yet recorded", () => {
    // Validity is checked directly rather than as a side effect of a subset
    // proof, because the identical-contract proof is skipped. It runs only for
    // an unrecorded contract — so `--update` must refuse to record one that is
    // invalid, or the finding would never be raised again.
    const current = contract(EMPTY_ARGUMENT, {
      type: "undefined",
      scope: "bogus",
    } as unknown as JSONSchema);
    const findings = checkPattern("system/home.tsx", current, []);

    const invalid = findings.filter((f) => f.kind === "invalid-schema");
    expect(invalid.length).toBe(1);
    expect(invalid[0]).toMatchObject({
      kind: "invalid-schema",
      pattern: "system/home.tsx",
      role: "result",
    });
  });

  it("reports a retired pattern whose baselines outlive its source", () => {
    const findings = checkPattern("system/gone.tsx", undefined, [
      baseline("v1", EMPTY_ARGUMENT, RESULT_WITH_TITLE),
    ]);

    expect(findings).toEqual([{
      kind: "retired",
      pattern: "system/gone.tsx",
      baselines: ["v1"],
    }]);
  });
});

describe("contractHash", () => {
  it("is stable across key order", () => {
    const a = contract(EMPTY_ARGUMENT, {
      type: "object",
      properties: { x: { type: "string" }, y: { type: "number" } },
    });
    const b = contract(EMPTY_ARGUMENT, {
      properties: { y: { type: "number" }, x: { type: "string" } },
      type: "object",
    });

    expect(contractHash(a)).toBe(contractHash(b));
  });

  it("separates contracts that differ only in the argument schema", () => {
    const a = contract(EMPTY_ARGUMENT, RESULT_WITH_TITLE);
    const b = contract({
      type: "object",
      properties: { seed: { type: "string" } },
    }, RESULT_WITH_TITLE);

    expect(contractHash(a)).not.toBe(contractHash(b));
  });
});

describe("parseArgs", () => {
  it("defaults to a plain check over everything", () => {
    expect(parseArgs([])).toEqual({ update: false, only: [] });
  });

  it("accepts --only in both spellings and collects repeats", () => {
    expect(parseArgs(["--only", "home", "--only=system/"])).toEqual({
      update: false,
      only: ["home", "system/"],
    });
  });

  it("rejects an unknown argument rather than silently checking everything", () => {
    expect(() => parseArgs(["--updat"])).toThrow(/Unknown argument/);
  });

  it("reads --update beside a filter", () => {
    expect(parseArgs(["--update", "--only", "home"])).toEqual({
      update: true,
      only: ["home"],
    });
  });

  it("refuses a filter with no value rather than checking everything", () => {
    expect(() => parseArgs(["--only"])).toThrow("--only needs a value");
  });
});

describe("baselineFileName", () => {
  it("stamps a sortable basic-format UTC time next to the hash", () => {
    const name = baselineFileName(
      new Date("2026-07-28T15:45:00.123Z"),
      "abc123",
    );
    expect(name).toBe("20260728T154500Z-abc123.json");
  });

  it("sorts chronologically as plain text", () => {
    const older = baselineFileName(new Date("2026-07-28T15:45:00Z"), "zzz");
    const newer = baselineFileName(new Date("2026-12-01T00:00:00Z"), "aaa");
    expect([newer, older].sort()).toEqual([older, newer]);
  });
});

describe("baseline encoding", () => {
  const stored = {
    pattern: "system/home.tsx",
    argumentSchema: EMPTY_ARGUMENT,
    resultSchema: RESULT_WITH_TITLE,
  };

  it("round-trips an ordinary contract", () => {
    expect(decodeBaseline(encodeBaseline(stored))).toEqual(stored);
  });

  it("is pretty-printed, because these files are read in review", () => {
    expect(encodeBaseline(stored)).toContain("\n  ");
    expect(encodeBaseline(stored).endsWith("\n")).toBe(true);
  });

  it("preserves values JSON.stringify would silently flatten", () => {
    // JSON.stringify renders -0 as 0 and the non-finites as null. A baseline
    // that flattened them could never match the contract it was recorded from,
    // so the gate would report a missing baseline forever.
    const hostile = {
      pattern: "x.tsx",
      argumentSchema: {
        type: "object",
        properties: {
          negZero: { type: "number", default: -0 },
          notANumber: { type: "number", default: NaN },
          infinite: { type: "number", default: Infinity },
        },
      },
      resultSchema: RESULT_WITH_TITLE,
    } as unknown as typeof stored;

    const properties = (decodeBaseline(encodeBaseline(hostile))
      .argumentSchema as Record<
        string,
        Record<string, Record<string, unknown>>
      >)
      .properties;
    expect(Object.is(properties.negZero.default, -0)).toBe(true);
    expect(Number.isNaN(properties.notANumber.default)).toBe(true);
    expect(properties.infinite.default).toBe(Infinity);
  });
});

describe("baseline store", () => {
  const contractOf = () => contract(EMPTY_ARGUMENT, RESULT_WITH_TITLE);

  /** Runs `body` against a throwaway baselines+patterns tree. */
  const withTree = async (
    body: (dirs: { baselines: string; patterns: string }) => Promise<void>,
  ) => {
    const root = await Deno.makeTempDir({ prefix: "pattern-compat-" });
    try {
      await body({
        baselines: `${root}/baselines`,
        patterns: `${root}/patterns`,
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  };

  it("reads back what it writes, round-tripping through the codec", async () => {
    await withTree(async ({ baselines }) => {
      const name = await writeBaseline(
        baselines,
        "system/home.tsx",
        contractOf(),
        new Date("2026-07-28T15:45:00Z"),
      );
      expect(name).toBe(
        `20260728T154500Z-${contractHash(contractOf())}.json`,
      );

      const read = await readBaselines(baselines, "system/home.tsx");
      expect(read.length).toBe(1);
      expect(contractHash(read[0].contract)).toBe(contractHash(contractOf()));
    });
  });

  it("treats an absent directory as no baselines, not an error", async () => {
    await withTree(async ({ baselines }) => {
      expect(await readBaselines(baselines, "never/existed.tsx")).toEqual([]);
      expect(await collectBaselineKeys(baselines)).toEqual([]);
    });
  });

  it("ignores non-JSON files rather than failing to decode them", async () => {
    await withTree(async ({ baselines }) => {
      await writeBaseline(baselines, "a.tsx", contractOf(), new Date());
      await Deno.writeTextFile(
        `${baselines}/a.tsx/README.md`,
        "not a baseline",
      );
      expect((await readBaselines(baselines, "a.tsx")).length).toBe(1);
    });
  });

  it("walks nested paths, stopping at the directory named for the pattern file", async () => {
    await withTree(async ({ baselines }) => {
      await writeBaseline(
        baselines,
        "system/home.tsx",
        contractOf(),
        new Date(),
      );
      await writeBaseline(
        baselines,
        "notes/note.tsx",
        contractOf(),
        new Date(),
      );
      await writeBaseline(baselines, "top.ts", contractOf(), new Date());

      expect(await collectBaselineKeys(baselines)).toEqual([
        "notes/note.tsx",
        "system/home.tsx",
        "top.ts",
      ]);
    });
  });

  it("lists a pattern whose file is gone, and only that one, beside the files", async () => {
    await withTree(async ({ baselines }) => {
      await writeBaseline(
        baselines,
        "system/home.tsx",
        contractOf(),
        new Date(),
      );
      await writeBaseline(
        baselines,
        "system/gone.tsx",
        contractOf(),
        new Date(),
      );
      const files = ["packages/patterns/system/home.tsx"];
      expect(await collectCompatibilityPaths(files, baselines, [])).toEqual([
        "packages/patterns/system/home.tsx",
        "packages/patterns/system/gone.tsx",
      ]);
    });
  });

  it("lists each gone pattern an accepted break names, once, including one with no baselines", async () => {
    await withTree(async ({ baselines }) => {
      await writeBaseline(
        baselines,
        "system/gone.tsx",
        contractOf(),
        new Date(),
      );
      const files = ["packages/patterns/system/home.tsx"];
      const paths = await collectCompatibilityPaths(files, baselines, [
        "system/home.tsx",
        "system/gone.tsx",
        "system/removed.tsx",
      ]);
      expect(paths).toEqual([
        "packages/patterns/system/home.tsx",
        "packages/patterns/system/gone.tsx",
        "packages/patterns/system/removed.tsx",
      ]);
    });
  });

  it("sorts baselines by label so the oldest is checked first", async () => {
    await withTree(async ({ baselines }) => {
      await writeBaseline(
        baselines,
        "a.tsx",
        contract(EMPTY_ARGUMENT, RESULT_WITH_TITLE),
        new Date("2026-12-01T00:00:00Z"),
      );
      await writeBaseline(
        baselines,
        "a.tsx",
        contract(EMPTY_ARGUMENT, RESULT_WITHOUT_TITLE),
        new Date("2026-01-01T00:00:00Z"),
      );
      const labels = (await readBaselines(baselines, "a.tsx")).map((b) =>
        b.label
      );
      expect(labels[0].startsWith("20260101")).toBe(true);
    });
  });
});

describe("selectItems", () => {
  const ITEMS = [
    "packages/patterns/notes/extra.tsx",
    "packages/patterns/notes/gone.tsx",
    "packages/patterns/notes/note.tsx",
    "packages/patterns/notes/other.tsx",
  ];

  it("selects every item when unfiltered", () => {
    expect(selectItems(ITEMS, [])).toEqual(ITEMS);
  });

  it("selects the items --only names", () => {
    expect(
      selectItems(ITEMS, ["notes/gone.tsx", "notes/other.tsx"]),
    ).toEqual([
      "packages/patterns/notes/gone.tsx",
      "packages/patterns/notes/other.tsx",
    ]);
    expect(selectItems(ITEMS, ["notes/note.tsx"])).toEqual([
      "packages/patterns/notes/note.tsx",
    ]);
  });
});

describe("incompatibilityPaths", () => {
  it("reads the path off each issue line", () => {
    expect(incompatibilityPaths(
      "Pattern schemas are not backward compatible:\n" +
        "- argument.topics[]: defaults changed below a constraint\n" +
        "- result.crossrefs: existing result field was removed",
    )).toEqual(["argument.topics[]", "result.crossrefs"]);
  });

  it("returns an unparseable issue line whole, so it matches no accepted path", () => {
    expect(incompatibilityPaths("- previous argument has an invalid schema"))
      .toEqual(["previous argument has an invalid schema"]);
  });

  it("returns nothing for a detail with no issue lines", () => {
    expect(incompatibilityPaths("something else entirely")).toEqual([]);
  });

  it("reads a root issue as the bare role", () => {
    // `schemaSubsetIssue` appends `.<property>` as it descends, so an issue
    // about the schema itself carries the role it started with and no pointer.
    // An entry forgiving one has to name it the same way.
    expect(incompatibilityPaths(
      "Pattern schemas are not backward compatible:\n" +
        "- result: ifc changed",
    )).toEqual(["result"]);
  });
});

describe("partitionAcceptedBreaks", () => {
  const incompatible = (
    pattern: string,
    baseline: string,
    ...issues: string[]
  ): Finding => ({
    kind: "incompatible",
    pattern,
    baseline,
    detail: `Pattern schemas are not backward compatible:\n${
      issues.map((issue) => `- ${issue}`).join("\n")
    }`,
  });
  const REMOVED = "result.crossrefs: existing result field was removed";
  const UNRELATED =
    "argument.seed: newly required argument field has no default";
  const accepted = new Map<string, ReadonlySet<string>>([
    [acceptedBreakKey("a.tsx", "old"), new Set(["result.crossrefs"])],
  ]);

  it("forgives a finding blaming only paths the entry names", () => {
    const finding = incompatible("a.tsx", "old", REMOVED);
    const { standing, forgiven } = partitionAcceptedBreaks(
      [finding],
      accepted,
    );
    expect(standing).toEqual([]);
    expect(forgiven).toEqual([finding]);
  });

  it("keeps a finding that also blames a path the entry does not name", () => {
    // One finding carries every issue found against that baseline. Forgiving by
    // pair alone would suppress an unintended break landing beside the accepted
    // one, and `--update` would record the broken contract as the new baseline.
    const finding = incompatible("a.tsx", "old", REMOVED, UNRELATED);
    const { standing, forgiven } = partitionAcceptedBreaks(
      [finding],
      accepted,
    );
    expect(standing).toEqual([finding]);
    expect(forgiven).toEqual([]);
  });

  it("keeps a finding whose detail names no path at all", () => {
    // Fails closed: an unrecognised message shape is not forgiven on the
    // strength of a format assumption.
    const finding: Finding = {
      kind: "incompatible",
      pattern: "a.tsx",
      baseline: "old",
      detail: "something this parser cannot read",
    };
    const { standing } = partitionAcceptedBreaks([finding], accepted);
    expect(standing).toEqual([finding]);
  });

  it("keeps a finding against a baseline the entry does not name", () => {
    // The bound that stops an acceptance becoming an off switch over time: the
    // contract recorded once the break ships is a baseline no entry names, so
    // the next change to the same pattern is gated against it.
    const finding = incompatible("a.tsx", "recorded-after-the-break", REMOVED);
    const { standing, forgiven } = partitionAcceptedBreaks(
      [finding],
      accepted,
    );
    expect(standing).toEqual([finding]);
    expect(forgiven).toEqual([]);
  });

  it("keeps a finding for a pattern the list does not name", () => {
    const finding = incompatible("b.tsx", "old", REMOVED);
    const { standing } = partitionAcceptedBreaks([finding], accepted);
    expect(standing).toEqual([finding]);
  });

  it("keeps every finding that is not an incompatibility", () => {
    // An acceptance says the break was decided; it says nothing about a
    // contract that is unrecorded, invalid, or outlived by its baselines.
    const others: Finding[] = [
      { kind: "missing-baseline", pattern: "a.tsx", hash: "h" },
      { kind: "invalid-schema", pattern: "a.tsx", role: "result", detail: "x" },
      { kind: "retired", pattern: "a.tsx", baselines: ["old"] },
    ];
    const { standing, forgiven } = partitionAcceptedBreaks(others, accepted);
    expect(standing).toEqual(others);
    expect(forgiven).toEqual([]);
  });
});

describe("shouldRecord", () => {
  const missing = (): Finding => ({
    kind: "missing-baseline",
    pattern: "a.tsx",
    hash: "h",
  });

  it("records a clean new contract", () => {
    expect(shouldRecord([missing()])).toBe(true);
  });

  it("records nothing when there is nothing new to record", () => {
    expect(shouldRecord([])).toBe(false);
  });

  it("refuses a contract that is invalid on its own terms", () => {
    // Validity is only checked for an UNrecorded contract, so recording an
    // invalid one would silence the finding permanently.
    expect(shouldRecord([missing(), {
      kind: "invalid-schema",
      pattern: "a.tsx",
      role: "result",
      detail: "bad",
    }])).toBe(false);
  });

  it("refuses a contract that cannot be applied over a deployed one", () => {
    // An incompatible contract cannot merge, so it is never deployed. Recording
    // it would force every future contract to prove itself against a version
    // that only ever existed in a failed run — in a store that is never pruned.
    expect(shouldRecord([missing(), {
      kind: "incompatible",
      pattern: "a.tsx",
      baseline: "v1",
      detail: "result.x removed",
    }])).toBe(false);
  });
});

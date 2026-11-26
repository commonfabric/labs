import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { PatternCompiler } from "../../../../runtime/runner/src/compiled/compile.deno.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../../../runtime/runner/src/storage/cache.deno.ts";
import {
  applyLedger,
  type BothRuns,
  compareRuns,
  exitStatusOf,
  type Finding,
  type Ledger,
  outcomeOf,
  runScenario,
  staleEntries,
} from "../both-paths-gate.ts";
import { gateCorpusScenarios } from "../both-paths-corpus.ts";
import {
  type GateScenario,
  type PathRun,
  PROFILE_NAMES,
} from "../both-paths-serving.ts";
import { errorStatesOf, linksIn } from "../both-paths-store.ts";

// An item whose title, a state cell whose type declares the clause
// `item-title`, a handler writes: both paths store the clause at
// `item/title`.
const ITEM: GateScenario = {
  name: "an item with a labeled title",
  pieces: [{
    name: "item",
    module: "base/pattern-compiler/compare/fixtures/labeled-item.tsx",
    as: "alice",
  }],
  steps: [{ stream: "name", event: { title: "first" }, as: "alice" }],
};

const ROLES = { alice: "A", bob: "B" } as const;

/**
 * The label entries of the document the result's `title` links to, at the
 * checkpoint `at`: where both paths store the clause `item-title`.
 */
const titleEntries = (run: PathRun, at: number) => {
  const { snapshot } = run.checkpoints[at];
  const result = snapshot.get(run.results.item, "space")!;
  const [{ link }] = linksIn(result).filter(({ path }) => path[0] === "title");
  const target = snapshot.get(link.id, "space")!;
  return (target.metadata?.labelMap.entries ?? []).filter((entry) =>
    entry.path.join("/") === link.path.join("/")
  );
};

/** The kinds and positions of what the comparison found, as text. */
const found = (findings: readonly Finding[]) =>
  findings.map(({ kind, position, principal }) =>
    `${kind} ${position}${principal === undefined ? "" : ` ${principal}`}`
  );

// These cases run the release build of the crate, which
// `cargo build --release` in `base/pattern-compiler` makes.
describe("the two-principal gate", () => {
  const compiler = new PatternCompiler();
  // One run of the item on both paths, which each case copies and edits.
  let ran: BothRuns;

  beforeAll(async () => {
    const result = await runScenario(ITEM, { roles: ROLES, compiler });
    ran = result.runs!;
  });

  /** A copy of the runs whose compiled run `edit` changes. */
  const edited = (edit: (compiled: PathRun) => void): BothRuns => {
    // Each document is copied with its stored envelope, and each
    // checkpoint with its reads; the stored values are shared, and an
    // edit puts a new value in the place of one.
    const compiled: PathRun = {
      ...ran.compiled,
      checkpoints: ran.compiled.checkpoints.map((checkpoint) => {
        const documents = checkpoint.snapshot.documents.map((document) => ({
          ...document,
          ...(document.metadata === undefined
            ? {}
            : { metadata: structuredClone(document.metadata) }),
        }));
        return {
          ...checkpoint,
          reads: { A: { ...checkpoint.reads.A }, B: { ...checkpoint.reads.B } },
          snapshot: {
            ...checkpoint.snapshot,
            documents,
            get: (id: string, scopeKey: string) =>
              documents.find((document) =>
                document.id === id && document.scopeKey === scopeKey
              ),
          },
        };
      }),
    };
    edit(compiled);
    return { ...ran, compiled };
  };

  it("finds no label difference at the title where both paths store the same clause", () => {
    for (const run of [ran.today, ran.compiled]) {
      expect(
        titleEntries(run, 1).some((entry) =>
          JSON.stringify(entry.label.confidentiality).includes("item-title")
        ),
      ).toBe(true);
    }

    const { findings } = compareRuns(ran);

    expect(
      findings.filter(({ kind, position, today, compiled }) =>
        kind.startsWith("label-") && position === "item/title" &&
        JSON.stringify([today, compiled]).includes("item-title")
      ),
    ).toEqual([]);
  });

  it("reports a clause today's path stores that the compiled path's stored envelope lacks", () => {
    const runs = edited((compiled) => {
      for (const entry of titleEntries(compiled, 1)) {
        entry.label.confidentiality = [];
      }
    });

    const { findings } = compareRuns(runs);

    expect(
      findings.filter(({ kind, position, at, today }) =>
        kind === "label-missing" && position === "item/title" &&
        at === "step 0" && String(today).includes("item-title")
      ).length,
    ).toBe(1);
  });

  it("reports a clause the compiled path's stored envelope holds that today's path does not store", () => {
    const runs = edited((compiled) => {
      for (const entry of titleEntries(compiled, 1)) {
        entry.label.confidentiality = [
          ...entry.label.confidentiality!,
          ["added-by-the-test"],
        ];
      }
    });

    const { findings } = compareRuns(runs);

    expect(
      findings.filter(({ kind, position, compiled }) =>
        kind === "label-extra" && position === "item/title" &&
        String(compiled).includes("added-by-the-test")
      ).length,
    ).toBe(1);
  });

  it("reports a principal's `User` clause in a document of the space, with the document, the position, the clause and the step", () => {
    const runs = edited((compiled) => {
      for (const entry of titleEntries(compiled, 1)) {
        entry.label.confidentiality = [
          ...entry.label.confidentiality!,
          [cfcAtom.user(compiled.identities.principals.B)],
        ];
      }
    });

    const { findings } = compareRuns(runs);
    const foreign = findings.filter(({ kind }) => kind === "foreign-clause");

    expect(found(foreign)).toEqual(["foreign-clause item/title B"]);
    expect(foreign[0].at).toBe("step 0");
    expect(foreign[0].on).toBe("compiled");
    expect(foreign[0].document).toMatch(/^of:[^/]+\/$/);
    expect(String(foreign[0].compiled)).toContain("User");
    expect(found(compareRuns(ran).findings)).not.toContain(
      "foreign-clause item/title B",
    );
  });

  it("reports text of A's scope that B reads, and not where no principal reads it", () => {
    const runs = edited((compiled) => {
      compiled.checkpoints[1].reads.B["item.name"] = {
        value: `first, by ${PROFILE_NAMES.A}`,
      };
    });

    const { findings } = compareRuns(runs);

    expect(
      found(findings.filter(({ kind }) => kind === "foreign-value")),
    ).toEqual(["foreign-value item.name B"]);
    expect(
      found(
        compareRuns(ran).findings.filter(({ kind }) =>
          kind === "foreign-value"
        ),
      ),
    ).toEqual([]);
  });

  it("reports text of A's scope that a document of the space holds where its label names no clause of A", () => {
    const runs = edited((compiled) => {
      const document = compiled.checkpoints[1].snapshot.get(
        compiled.results.item,
        "space",
      )!;
      document.value = {
        ...(document.value as Record<string, unknown>),
        note: PROFILE_NAMES.A,
      } as never;
    });

    const { findings } = compareRuns(runs);

    expect(
      found(findings.filter(({ kind }) => kind === "foreign-value")),
    ).toEqual(["foreign-value item/note B"]);
  });

  it("reports a value that differs for B alone, for B and not for A", () => {
    const runs = edited((compiled) => {
      compiled.checkpoints[1].reads.B["item.name"] = { value: "other" };
    });

    const values = compareRuns(runs).findings.filter(({ kind }) =>
      kind === "value"
    );

    expect(found(values)).toEqual(["value item.name B"]);
    expect(
      compareRuns(ran).findings.filter(({ kind }) => kind === "value"),
    ).toEqual([]);
  });

  it("reports a read one path refuses as hidden", () => {
    const runs = edited((compiled) => {
      compiled.checkpoints[1].reads.A["item.name"] = {
        hidden: "hidden by policy (consumed)",
      };
    });

    expect(
      found(compareRuns(runs).findings.filter(({ kind }) => kind === "hidden")),
    ).toEqual(["hidden item.name A"]);
  });
});

describe("the error states of a store", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await Deno.makeTempDir({ prefix: "two-principals-test-" });
  });

  afterAll(async () => {
    await Deno.remove(directory, { recursive: true });
  });

  it("counts an error state of an older revision that the current revision no longer holds", async () => {
    const store = new URL(`file://${directory}/`);
    const identity = await Identity.fromPassphrase("two principals errors");
    const server = newLoopbackServer({ store, subscriptionRefreshDelayMs: 0 });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: identity,
      }),
    });
    try {
      const cell = runtime.getCell<unknown>(identity.did(), "a document");
      for (
        const value of [
          { shown: { $error: { message: "an older failure" } } },
          { shown: "repaired" },
        ]
      ) {
        const tx = runtime.edit();
        cell.withTx(tx).set(value);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await runtime.storageManager.synced();
      await server.idle();

      const counts = errorStatesOf(store, [identity.did()]);

      expect(counts.current).toEqual({});
      expect(counts.all).toEqual({ "an older failure": 1 });
    } finally {
      await runtime.dispose();
      await server.close();
    }
  });
});

describe("the ledger of accepted differences", () => {
  const finding: Finding = {
    scenario: "a scenario",
    at: "step 0",
    kind: "label-extra",
    position: "piece/member",
    compiled: "confidentiality [x]",
  };
  const entry = {
    scenario: "a scenario",
    step: "*",
    position: "piece/*",
    kind: "label-extra",
    today: "nothing",
    compiled: "the clause x",
    decision: "P0 (a test), provisional, not ratified",
    ratified: false,
  };

  it("lets a run pass where an entry covers each difference", () => {
    const findings = [{ ...finding }];
    const ledger: Ledger = { entries: [entry] };

    const covered = applyLedger(ledger, findings);
    const outcome = outcomeOf(findings);

    expect(covered).toEqual([1]);
    expect(outcome).toEqual({ status: "equal" });
    expect(
      exitStatusOf([outcome], staleEntries(ledger, covered, ["a scenario"])),
    )
      .toBe(0);
  });

  it("fails a run where a difference has no entry", () => {
    const findings = [{ ...finding }];
    const ledger: Ledger = { entries: [] };

    applyLedger(ledger, findings);
    const outcome = outcomeOf(findings);

    expect(outcome).toEqual({
      status: "differing",
      counts: { "label-extra": 1 },
    });
    expect(exitStatusOf([outcome], [])).toBe(1);
  });

  it("fails a run where an entry covers nothing", () => {
    const findings: Finding[] = [];
    const ledger: Ledger = { entries: [entry] };

    const covered = applyLedger(ledger, findings);
    const stale = staleEntries(ledger, covered, ["a scenario"]);

    expect(stale).toEqual([entry]);
    expect(exitStatusOf([outcomeOf(findings)], stale)).toBe(1);
  });
});

describe("a scenario the harness cannot drive", () => {
  const compiler = new PatternCompiler();

  it("is skipped with its reason and never equal", async () => {
    const result = await runScenario({
      name: "a module that does not exist",
      pieces: [{ name: "piece", module: "patterns/no/such/module.tsx" }],
      steps: [],
    }, { roles: ROLES, compiler });

    expect(result.outcome.status).toBe("skipped");
    // A run in which nothing ran is no evidence, so it fails.
    expect(exitStatusOf([result.outcome], [])).toBe(1);
  });

  it("is skipped where the scenario says why it cannot run", async () => {
    const [effect] = (await gateCorpusScenarios()).filter(({ skip }) =>
      skip?.startsWith("requests an effect")
    );

    const result = await runScenario(effect, { roles: ROLES, compiler });

    expect(result.outcome).toEqual({ status: "skipped", reason: effect.skip });
  });
});

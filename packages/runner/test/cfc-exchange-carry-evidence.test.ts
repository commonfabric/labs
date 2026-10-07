import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { AtomPattern } from "../src/cfc/atom-pattern.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { CfcPolicyRecordInput, ExchangeRule } from "../src/cfc/policy.ts";
import type {
  ImplementationIdentity,
  LabelMapEntry,
} from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

// What evidence a value-intrinsic exchange rule may rest on when a
// transformation observes a label (spec §5.3), and what never carries. Each
// case seeds the label map of one input document, runs one transformation over
// it under an implementation identity, and reads the confidentiality the
// transformation's output was stamped with. The rule releases the room clause
// of a value the `project` step computed.

const signer = await Identity.fromPassphrase(
  "runner-cfc-exchange-carry-evidence",
);
const space = signer.did();

const ROOM = cfcAtom.space(space);

const verified = (symbol: string): ImplementationIdentity => ({
  kind: "verified",
  moduleIdentity: "module:card",
  symbol,
  bindingPath: [symbol],
});

const PROJECT = verified("project");
const OTHER = verified("other");
const READER = verified("reader");

const transformedBy = (identity: ImplementationIdentity) => ({
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: {
    kind: "verified",
    moduleIdentity: (identity as { moduleIdentity: string }).moduleIdentity,
    symbol: (identity as { symbol: string }).symbol,
  },
});

const releaseRule = (
  preCondition: ExchangeRule["preCondition"],
): ExchangeRule => ({
  id: "release-card",
  appliesTo: ROOM,
  preCondition,
  post: { dropClause: true },
});

const RELEASE: CfcPolicyRecordInput[] = [{
  id: "card-release",
  rules: [releaseRule({ integrity: [transformedBy(PROJECT)] })],
}];

const withRuntime = async (
  records: CfcPolicyRecordInput[],
  body: (runtime: Runtime) => Promise<void>,
  cfcPolicyEvaluation: "observe" | "enforce" = "enforce",
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcFlowLabels: "persist",
    cfcPolicyRecords: records,
    cfcPolicyEvaluation,
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** A document seeded with exactly `entries` as its label map. */
const seedLabeled = async (
  runtime: Runtime,
  cause: string,
  value: FabricValue,
  entries: readonly LabelMapEntry[],
): Promise<void> => {
  const seed = runtime.edit();
  const id = runtime.getCell(space, cause, undefined, seed)
    .getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
    value,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries: [...entries] },
    },
  });
  expect((await seed.commit().settled).ok).toBeDefined();
};

/**
 * Reads `input` whole under the `READER` identity, writes what it read into
 * `output`, and returns the diagnostics prepare recorded.
 */
const derive = async (
  runtime: Runtime,
  input: string,
  output: string,
): Promise<readonly string[]> => {
  const tx = runtime.edit();
  setCfcImplementationIdentity(tx, READER);
  const value = runtime.getCell(space, input, undefined, tx).getRaw();
  const id = runtime.getCell(space, output, undefined, tx)
    .getAsNormalizedFullLink().id;
  tx.writeOrThrow(
    { space, scope: "space", id, path: ["value"] },
    { copied: JSON.stringify(value) },
  );
  tx.prepareCfc();
  const diagnostics = [...tx.getCfcState().diagnostics];
  expect((await tx.commit().settled).error).toBeUndefined();
  return diagnostics;
};

/** The output's derived value stamps. */
const stampsOf = (runtime: Runtime, cause: string): LabelMapEntry[] => {
  const tx = runtime.edit();
  try {
    const link = runtime.getCell(space, cause, undefined, tx)
      .getAsNormalizedFullLink();
    return (readStoredCfcMetadata(tx, link)?.labelMap.entries ?? []).filter(
      (entry) => entry.origin === "derived" && entry.observes === "value",
    );
  } finally {
    tx.abort();
  }
};

const confidentialityOf = (entries: readonly LabelMapEntry[]): unknown[] =>
  entries.flatMap((entry) => entry.label.confidentiality ?? []);

const witnessesOf = (entries: readonly LabelMapEntry[]): unknown[] =>
  entries.flatMap((entry) =>
    (entry.label.integrity ?? []).flatMap((atom) => {
      const witness = (atom as { inputWitness?: unknown }).inputWitness;
      return witness === undefined ? [] : [witness];
    })
  );

/** A value stamp at `path`, as a writer's flow join leaves one. */
const stamp = (
  path: string[],
  writer: ImplementationIdentity,
  origin: LabelMapEntry["origin"] = "derived",
): LabelMapEntry => ({
  path,
  origin,
  observes: "value",
  label: { confidentiality: [ROOM], integrity: [transformedBy(writer)] },
});

describe("value-intrinsic exchange evidence", () => {
  it("drops a clause the observed location's own stamp releases, and records the guard as a witness", async () => {
    await withRuntime(RELEASE, async (runtime) => {
      await seedLabeled(runtime, "card", { text: "released" }, [
        stamp([], PROJECT),
      ]);
      await derive(runtime, "card", "out");
      const stamps = stampsOf(runtime, "out");
      expect(stamps.length).toBeGreaterThan(0);
      expect(confidentialityOf(stamps)).toEqual([]);
      expect(witnessesOf(stamps)).toContainEqual(transformedBy(PROJECT));
    });
  });

  it("drops the existence clause beside a value stamp that releases the value", async () => {
    await withRuntime(RELEASE, async (runtime) => {
      await seedLabeled(runtime, "card", { text: "released" }, [
        {
          path: [],
          origin: "derived",
          observes: "shape",
          label: {
            confidentiality: [ROOM],
          },
        },
        stamp([], PROJECT),
      ]);
      await derive(runtime, "card", "out");
      expect(confidentialityOf(stampsOf(runtime, "out"))).toEqual([]);
    });
  });

  it("keeps a clause another path of the same read carries without the evidence", async () => {
    await withRuntime(RELEASE, async (runtime) => {
      await seedLabeled(runtime, "card", { a: "released", b: "sealed" }, [
        stamp(["a"], PROJECT),
        stamp(["b"], OTHER),
      ]);
      await derive(runtime, "card", "out");
      expect(confidentialityOf(stampsOf(runtime, "out"))).toContainEqual(ROOM);
    });
  });

  it("keeps a clause whose only evidence is a declared or link-carried entry's integrity", async () => {
    for (const origin of ["declared", "link"] as const) {
      await withRuntime(RELEASE, async (runtime) => {
        await seedLabeled(runtime, "card", { text: "sealed" }, [
          stamp([], PROJECT, origin),
        ]);
        await derive(runtime, "card", "out");
        expect(confidentialityOf(stampsOf(runtime, "out"))).toContainEqual(
          ROOM,
        );
      });
    }
  });

  it("keeps a membership clause a link entry beside it would release", async () => {
    // A filter's output slot: the reference it holds carries the released
    // element's label and evidence, and the slot's own stamp records the
    // filter's decision, which read a sealed predicate.
    await withRuntime(RELEASE, async (runtime) => {
      await seedLabeled(runtime, "card", { text: "kept" }, [
        stamp([], PROJECT, "link"),
        stamp([], OTHER, "structure"),
      ]);
      await derive(runtime, "card", "out");
      expect(confidentialityOf(stampsOf(runtime, "out"))).toContainEqual(ROOM);
    });
  });

  describe("rules that do not carry", () => {
    const cases: [string, ExchangeRule["preCondition"]][] = [
      ["grant-guarded", {
        integrity: [transformedBy(PROJECT)],
        policyState: [{ kind: "approved" }],
      }],
      ["boundary-scoped", {
        integrity: [transformedBy(PROJECT)],
        boundary: [{ type: CFC_ATOM_TYPE.BoundaryContext }],
      }],
      ["guarded by access evidence", {
        integrity: [{ type: CFC_ATOM_TYPE.HasRole } as AtomPattern],
      }],
    ];
    for (const [name, preCondition] of cases) {
      it(`keeps the clause a ${name} rule would drop`, async () => {
        await withRuntime([{
          id: "card-release",
          rules: [releaseRule(preCondition)],
        }], async (runtime) => {
          await seedLabeled(runtime, "card", { text: "sealed" }, [{
            path: [],
            origin: "derived",
            observes: "value",
            label: {
              confidentiality: [ROOM],
              integrity: [
                transformedBy(PROJECT),
                cfcAtom.hasRole(space, space, "reader"),
              ],
            },
          }]);
          await derive(runtime, "card", "out");
          expect(confidentialityOf(stampsOf(runtime, "out"))).toContainEqual(
            ROOM,
          );
        });
      });
    }
  });

  it("keeps the label and records why when the rules exhaust their fuel", async () => {
    const MARK = { type: "https://example.com/atoms/Mark" };
    const guard = { integrity: [transformedBy(PROJECT)] };
    await withRuntime([{
      id: "card-release",
      rules: [
        {
          id: "add-mark",
          appliesTo: ROOM,
          preCondition: guard,
          post: { addAlternatives: [MARK] },
        },
        {
          id: "drop-mark",
          appliesTo: MARK,
          preCondition: guard,
          post: { dropClause: true },
        },
      ],
    }], async (runtime) => {
      await seedLabeled(runtime, "card", { text: "sealed" }, [
        stamp([], PROJECT),
      ]);
      const diagnostics = await derive(runtime, "card", "out");
      expect(confidentialityOf(stampsOf(runtime, "out"))).toContainEqual(ROOM);
      expect(
        diagnostics.some((note) => note.includes("ran out of fuel")),
      ).toBe(true);
    });
  });

  it("keeps the clause and says what enforce would carry when policy evaluation only observes", async () => {
    await withRuntime(RELEASE, async (runtime) => {
      await seedLabeled(runtime, "card", { text: "released" }, [
        stamp([], PROJECT),
      ]);
      const diagnostics = await derive(runtime, "card", "out");
      expect(confidentialityOf(stampsOf(runtime, "out"))).toContainEqual(ROOM);
      expect(
        diagnostics.some((note) =>
          note.includes("value-intrinsic exchange would leave 0 of 1")
        ),
      ).toBe(true);
    }, "observe");
  });

  it("records why it kept the label when a module policy does not resolve", async () => {
    // A policy reference to a manifest this space never installed, which the
    // destination's own manifest check also refuses to store, so the case
    // reads what prepare recorded rather than what a commit stored.
    const UNINSTALLED = {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      subject: space,
      moduleIdentity: "module:uninstalled",
      symbol: "rules",
      policyDigest: "uninstalled-digest",
    };
    await withRuntime([], async (runtime) => {
      await seedLabeled(runtime, "card", { text: "sealed" }, [{
        path: [],
        origin: "derived",
        observes: "value",
        label: {
          confidentiality: [UNINSTALLED],
          integrity: [transformedBy(PROJECT)],
        },
      }]);
      const tx = runtime.edit();
      try {
        setCfcImplementationIdentity(tx, READER);
        const value = runtime.getCell(space, "card", undefined, tx).getRaw();
        runtime.getCell(space, "out", undefined, tx).setRaw(
          { copied: JSON.stringify(value) } as never,
        );
        tx.prepareCfc();
        expect(
          tx.getCfcState().diagnostics.some((note) =>
            note.includes("value-intrinsic exchange kept the label read") &&
            note.includes("module policy")
          ),
        ).toBe(true);
      } finally {
        tx.abort();
      }
    });
  });

  describe("a reference copying a stored label", () => {
    /** Writes a reference to `input` into `output`; returns the diagnostics. */
    const link = async (
      runtime: Runtime,
      input: string,
      output: string,
    ): Promise<readonly string[]> => {
      const tx = runtime.edit();
      setCfcImplementationIdentity(tx, READER);
      const source = runtime.getCell(space, input, undefined, tx);
      runtime.getCell(space, output, undefined, tx).set(source as never);
      tx.prepareCfc();
      const diagnostics = [...tx.getCfcState().diagnostics];
      expect((await tx.commit().settled).error).toBeUndefined();
      return diagnostics;
    };

    /** The output's link-carried entries. */
    const linkEntriesOf = (runtime: Runtime, cause: string) => {
      const tx = runtime.edit();
      try {
        const at = runtime.getCell(space, cause, undefined, tx)
          .getAsNormalizedFullLink();
        return (readStoredCfcMetadata(tx, at)?.labelMap.entries ?? [])
          .filter((entry) => entry.origin === "link");
      } finally {
        tx.abort();
      }
    };

    it("copies the clause the source's own stamp releases as released", async () => {
      await withRuntime(RELEASE, async (runtime) => {
        await seedLabeled(runtime, "card", { text: "released" }, [
          stamp([], PROJECT),
        ]);
        await link(runtime, "card", "out");
        const entries = linkEntriesOf(runtime, "out");
        expect(entries.length).toBeGreaterThan(0);
        expect(confidentialityOf(entries)).toEqual([]);
      });
    });

    it("copies the clause as read, and says what enforce would copy, when policy evaluation only observes", async () => {
      await withRuntime(RELEASE, async (runtime) => {
        await seedLabeled(runtime, "card", { text: "released" }, [
          stamp([], PROJECT),
        ]);
        const diagnostics = await link(runtime, "card", "out");
        expect(confidentialityOf(linkEntriesOf(runtime, "out")))
          .toContainEqual(ROOM);
        expect(
          diagnostics.some((note) =>
            note.includes("would leave 0 of 1") &&
            note.includes("on a reference copied from")
          ),
        ).toBe(true);
      }, "observe");
    });
  });
});

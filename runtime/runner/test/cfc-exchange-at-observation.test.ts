import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { CfcPolicyRecordInput } from "../src/cfc/policy.ts";
import type {
  CfcPolicyEvaluationMode,
  ImplementationIdentity,
  LabelMapEntry,
} from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runner-cfc-exchange-observation");
const space = signer.did();

const ALICE = "did:key:alice";
const BOB = "did:key:bob";

// The sealed clause names the documents' own space, so a write that carries
// it fits the store it lands in.
const SEALED = cfcAtom.space(space);

const verified = (symbol: string): ImplementationIdentity => ({
  kind: "verified",
  moduleIdentity: "module:table",
  symbol,
  bindingPath: [symbol],
});

const VIEW = verified("viewFor");
const TALLY = verified("tallyBallot");
const OTHER = verified("peek");
const DERIVE = verified("describeSeat");

const transformedBy = (
  identity: ImplementationIdentity,
  viewer?: string,
): CfcAtom =>
  ({
    type: CFC_ATOM_TYPE.TransformedBy,
    identity,
    ...(viewer === undefined ? {} : { viewer }),
  }) as CfcAtom;

/** The sealed clause with `viewer` beside it, as the viewer rule leaves it. */
const releasedTo = (viewer: string): CfcConfClause =>
  ({ anyOf: [SEALED, cfcAtom.user(viewer)] }) as CfcConfClause;

const RULES: CfcPolicyRecordInput[] = [{
  id: "table",
  rules: [
    // Value-intrinsic: what `viewFor` wrote for a viewer is the viewer's too.
    {
      id: "release-own-view",
      appliesTo: SEALED,
      preCondition: {
        integrity: [{
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: {
            kind: "verified",
            moduleIdentity: "module:table",
            symbol: "viewFor",
          },
          viewer: { var: "$viewer" },
        }],
      },
      post: {
        addAlternatives: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "$viewer" },
        }],
      },
    },
    // Value-intrinsic: what `tallyBallot` wrote is public.
    {
      id: "release-tally",
      appliesTo: SEALED,
      preCondition: {
        integrity: [{
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: {
            kind: "verified",
            moduleIdentity: "module:table",
            symbol: "tallyBallot",
          },
        }],
      },
      post: { dropClause: true },
    },
  ],
}];

// The same release as `release-tally`, held to one sink: boundary-scoped, so
// what it leaves is the boundary's and travels nowhere (§5.3).
const SINK_SCOPED_RULES: CfcPolicyRecordInput[] = [{
  id: "table",
  rules: [{
    id: "release-tally-at-sink",
    appliesTo: SEALED,
    preCondition: {
      integrity: [{
        type: CFC_ATOM_TYPE.TransformedBy,
        identity: {
          kind: "verified",
          moduleIdentity: "module:table",
          symbol: "tallyBallot",
        },
      }],
      boundary: [cfcAtom.boundaryContext("sink", "fetchJson")],
    },
    post: { dropClause: true },
  }],
}];

const withRuntime = async (
  body: (runtime: Runtime) => Promise<void>,
  options: {
    rules?: readonly CfcPolicyRecordInput[];
    evaluation?: CfcPolicyEvaluationMode;
  } = {},
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcFlowLabels: "persist",
    cfcPolicyRecords: options.rules ?? RULES,
    cfcPolicyEvaluation: options.evaluation ?? "enforce",
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

const idOf = (
  runtime: Runtime,
  cause: string,
  tx: IExtendedStorageTransaction,
) => runtime.getCell(space, cause, undefined, tx).getAsNormalizedFullLink().id;

/** A document holding `value`, with `entries` as its label map. */
const seed = async (
  runtime: Runtime,
  cause: string,
  value: FabricValue,
  entries: LabelMapEntry[],
): Promise<void> => {
  const tx = runtime.edit();
  writeSeedEnvelopeDoc(tx, space);
  seedStoredEnvelope(tx, {
    space,
    scope: "space",
    id: idOf(runtime, cause, tx),
    path: [],
  }, {
    value,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries },
    },
  });
  expect((await tx.commit().settled).ok).toBeDefined();
};

/**
 * A sealed document holding `value`, whose value stamp carries `integrity`:
 * what a computation that wrote it whole leaves there.
 */
const seedStamped = (
  runtime: Runtime,
  cause: string,
  value: FabricValue,
  integrity: CfcAtom[],
): Promise<void> =>
  seed(runtime, cause, value, [{
    path: [],
    origin: "derived",
    observes: "value",
    label: { confidentiality: [SEALED], integrity },
  }]);

/**
 * One computation under `DERIVE`: reads each of `inputs` whole and writes a
 * value of them to `output`. The write is raw, so the output's own prior
 * value is not read as an input.
 */
const derive = async (
  runtime: Runtime,
  inputs: readonly string[],
  output: string,
): Promise<void> => {
  const tx = runtime.edit();
  setCfcImplementationIdentity(tx, DERIVE);
  const values = inputs.map((cause) =>
    runtime.getCell(space, cause, undefined, tx).getRaw()
  );
  tx.writeOrThrow({
    space,
    scope: "space",
    id: idOf(runtime, output, tx),
    path: ["value"],
  }, JSON.stringify(values));
  tx.prepareCfc();
  expect((await tx.commit().settled).error).toBeUndefined();
};

/** The clauses the value stamp of the document `cause` carries. */
const clausesOf = (runtime: Runtime, cause: string): unknown[] => {
  const tx = runtime.readTx();
  const cfc = tx.readOrThrow({
    space,
    scope: "space",
    id: idOf(runtime, cause, tx),
    path: ["cfc"],
  }) as { labelMap?: { entries?: LabelMapEntry[] } } | undefined;
  return (cfc?.labelMap?.entries ?? [])
    .filter((entry) => entry.origin === "derived" && entry.observes === "value")
    .flatMap((entry) => entry.label.confidentiality ?? []);
};

describe("exchange at observation", () => {
  // A value-intrinsic rule is guarded by evidence bound to the value a
  // computation read, which the flow join drops. So it is applied where that
  // value is read, and what the computation writes carries the clause as the
  // rule left it (§5.3).

  describe("a derivation of one released value", () => {
    it("carries the viewer the rule added beside the sealed clause", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "alice-view", { hand: ["AS"] }, [
          transformedBy(VIEW),
          transformedBy(VIEW, ALICE),
        ]);
        await derive(runtime, ["alice-view"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([releasedTo(ALICE)]);
      });
    });

    it("carries no clause where the rule dropped it", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "tally", "2-1", [transformedBy(TALLY)]);
        await derive(runtime, ["tally"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([]);
      });
    });

    it("carries the released clause on through a second derivation", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "alice-view", { hand: ["AS"] }, [
          transformedBy(VIEW, ALICE),
        ]);
        await derive(runtime, ["alice-view"], "derived");
        await derive(runtime, ["derived"], "derived-again");
        expect(clausesOf(runtime, "derived-again")).toEqual([
          releasedTo(ALICE),
        ]);
      });
    });
  });

  describe("a derivation that read more than one released value", () => {
    it("keeps the sealed clause of an input no rule released", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "alice-view", { hand: ["AS"] }, [
          transformedBy(VIEW, ALICE),
        ]);
        await seedStamped(runtime, "state", { deck: ["KH"] }, []);
        await derive(runtime, ["alice-view", "state"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([
          releasedTo(ALICE),
          SEALED,
        ]);
      });
    });

    it("carries one clause for each viewer whose value it read", async () => {
      // Each clause admits one of them, so the two together admit neither.

      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "alice-view", { hand: ["AS"] }, [
          transformedBy(VIEW, ALICE),
        ]);
        await seedStamped(runtime, "bob-view", { hand: ["KH"] }, [
          transformedBy(VIEW, BOB),
        ]);
        await derive(runtime, ["alice-view", "bob-view"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([
          releasedTo(ALICE),
          releasedTo(BOB),
        ]);
      });
    });

    it("keeps the sealed clause beside a clause the rule dropped", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "tally", "2-1", [transformedBy(TALLY)]);
        await seedStamped(runtime, "state", { deck: ["KH"] }, []);
        await derive(runtime, ["tally", "state"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      });
    });
  });

  describe("a derivation of a value no rule releases", () => {
    it("keeps the sealed clause of a value other code wrote", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "peeked", "AS KH", [
          transformedBy(OTHER),
          transformedBy(OTHER, ALICE),
        ]);
        await derive(runtime, ["peeked"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      });
    });

    it("keeps the sealed clause where the evidence is declared, not stamped", async () => {
      // A schema's declaration is store policy. It says nothing about who
      // wrote the value now stored, so no rule is matched against it.

      await withRuntime(async (runtime) => {
        await seed(runtime, "declared", { hand: ["AS"] }, [{
          path: [],
          origin: "declared",
          label: {
            confidentiality: [SEALED],
            integrity: [transformedBy(VIEW, ALICE)],
          },
        }]);
        await derive(runtime, ["declared"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      });
    });
  });

  describe("a rule that is not value-intrinsic", () => {
    it("leaves the sealed clause on what is derived", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "tally", "2-1", [transformedBy(TALLY)]);
        await derive(runtime, ["tally"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      }, { rules: SINK_SCOPED_RULES });
    });
  });

  describe("with policy evaluation at observe", () => {
    it("leaves the sealed clause on what is derived", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "tally", "2-1", [transformedBy(TALLY)]);
        await derive(runtime, ["tally"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      }, { evaluation: "observe" });
    });
  });
});

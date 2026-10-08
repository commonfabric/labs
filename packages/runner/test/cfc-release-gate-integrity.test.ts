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
import type { JSONSchema } from "../src/builder/types.ts";
import type { AtomPattern } from "../src/cfc/atom-pattern.ts";
import type { CfcPolicyRecordInput } from "../src/cfc/policy.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

// An exchange rule releases a clause when the integrity it requires is
// present (§5.3). That integrity has to describe the value the clause came
// from: §8.12.8 forbids an integrity union across a value's components, and
// §8.10.1.1 labels a value materialized from several observations with their
// join, which keeps a value-bound atom such as `TransformedBy` only where one
// stamp vouches for every part (§3.1.6.2). The cases here put an endorsed
// output beside a secret no endorsed code wrote, and read the two through one
// access.

const signer = await Identity.fromPassphrase("runner-cfc-release-gate");
const space = signer.did();

// The room clause names the room's own space, so a write into the room's own
// documents fits, and only a public ceiling stands in the way.
const ROOM = cfcAtom.space(space);

const verified = (
  moduleIdentity: string,
  symbol: string,
): ImplementationIdentity => ({
  kind: "verified",
  moduleIdentity,
  symbol,
  bindingPath: [symbol],
});

const COMMIT = verified("module:conclave", "commitStances");
const TALLY = verified("module:conclave", "tallyBallot");
const ATTACKER = verified("module:attacker", "copyNote");

// The guard: the tally wrote the value, over inputs the commit step wrote.
const WITNESSED_GUARD: AtomPattern = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: {
    kind: "verified",
    moduleIdentity: "module:conclave",
    symbol: "tallyBallot",
  },
  inputWitness: {
    type: CFC_ATOM_TYPE.TransformedBy,
    identity: {
      kind: "verified",
      moduleIdentity: "module:conclave",
      symbol: "commitStances",
    },
  },
};

const RELEASE_RULE: CfcPolicyRecordInput[] = [{
  id: "conclave-release",
  rules: [{
    id: "release-ballot",
    appliesTo: ROOM,
    preCondition: { integrity: [WITNESSED_GUARD] },
    post: { dropClause: true },
  }],
}];

// A room-visible store that may hold only public values: a write into it is
// fitted against a public ceiling, where the rule gets its chance.
const PUBLIC_STORE_SCHEMA = {
  type: "object",
  ifc: { confidentiality: [ROOM] },
  properties: {
    out: { type: "string", ifc: { maxConfidentiality: [] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SINK = "fetchJson";

const withRuntime = async (
  body: (runtime: Runtime) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcFlowLabels: "persist",
    cfcPolicyRecords: RELEASE_RULE,
    cfcPolicyEvaluation: "enforce",
    cfcSinkMaxConfidentiality: { [SINK]: [] },
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

/** A room-confidential document holding one member's sealed note. */
const seedSecret = async (
  runtime: Runtime,
  cause: string,
  note: string,
): Promise<void> => {
  const seed = runtime.edit();
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, {
    space,
    scope: "space",
    id: idOf(runtime, cause, seed),
    path: [],
  }, {
    value: { note },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{ path: [], label: { confidentiality: [ROOM] } }],
      },
    },
  });
  expect((await seed.commit().settled).ok).toBeDefined();
};

/** A public document: no label at all. */
const seedPublic = async (
  runtime: Runtime,
  cause: string,
  value: FabricValue,
): Promise<void> => {
  const tx = runtime.edit();
  tx.writeOrThrow({
    space,
    scope: "space",
    id: idOf(runtime, cause, tx),
    path: ["value"],
  }, value);
  expect((await tx.commit().settled).ok).toBeDefined();
};

/**
 * One transformation under `identity`: reads each input whole and writes what
 * `compute` makes of them at `path` of `output`. The write is raw, so the
 * output's own prior value is not read as an input.
 */
const transform = async (
  runtime: Runtime,
  identity: ImplementationIdentity,
  inputs: readonly string[],
  output: string,
  compute: (values: unknown[]) => FabricValue,
  path: readonly string[] = [],
): Promise<void> => {
  const tx = runtime.edit();
  setCfcImplementationIdentity(tx, identity);
  const values = inputs.map((cause) =>
    runtime.getCell(space, cause, undefined, tx).getRaw()
  );
  tx.writeOrThrow(
    {
      space,
      scope: "space",
      id: idOf(runtime, output, tx),
      path: ["value", ...path],
    },
    compute(values),
  );
  tx.prepareCfc();
  expect((await tx.commit().settled).error).toBeUndefined();
};

const tally = (values: unknown[]): string => {
  let approve = 0;
  for (const value of values) {
    for (const vote of (value as { votes?: string[] }).votes ?? []) {
      if (vote === "approve") approve++;
    }
  }
  return `${approve}`;
};

/**
 * The room as the attack leaves it. `shared` exists, public and empty, before
 * either write, so no stamp at its root speaks for both of its fields. The
 * tally writes its endorsed count at `/a`, over inputs the commit step wrote,
 * and other code copies Alice's note to `/b`.
 */
const seedSharedRoom = async (runtime: Runtime): Promise<void> => {
  await seedSecret(runtime, "alice-note", "alice-secret");
  await seedSecret(runtime, "bob-note", "bob-secret");
  await transform(
    runtime,
    COMMIT,
    ["alice-note", "bob-note"],
    "committed",
    () => ({
      votes: ["approve", "reject"],
    }),
  );
  await seedPublic(runtime, "shared", {});
  await transform(runtime, TALLY, ["committed"], "shared", tally, ["a"]);
  await transform(
    runtime,
    ATTACKER,
    ["alice-note"],
    "shared",
    ([alice]) => (alice as { note: string }).note,
    ["b"],
  );
};

/** The tally's count on its own, in a document of its own. */
const seedBallot = async (runtime: Runtime): Promise<void> => {
  await seedSecret(runtime, "alice-note", "alice-secret");
  await seedSecret(runtime, "bob-note", "bob-secret");
  await transform(
    runtime,
    COMMIT,
    ["alice-note", "bob-note"],
    "committed",
    () => ({
      votes: ["approve", "reject"],
    }),
  );
  await transform(runtime, TALLY, ["committed"], "ballot", tally);
};

type Prepared = {
  readonly reasons: readonly string[];
  readonly diagnostics: readonly string[];
};

const preparedOf = (tx: IExtendedStorageTransaction): Prepared => {
  tx.prepareCfc();
  const state = tx.getCfcState();
  const reasons = state.prepare.status === "invalidated"
    ? [...state.prepare.reasons]
    : [];
  const diagnostics = [...state.diagnostics];
  tx.abort();
  return { reasons, diagnostics };
};

/** Reads `cause` at `path` and writes what it read into a public store. */
const publish = (
  runtime: Runtime,
  cause: string,
  path: readonly string[] = [],
): Prepared & { readonly published: string } => {
  const tx = runtime.edit();
  const value = runtime.getCell(space, cause, undefined, tx).key(
    ...(path as [string]),
  ).getRaw();
  const published = JSON.stringify(value);
  runtime.getCell(space, `${cause}-public-store`, PUBLIC_STORE_SCHEMA, tx)
    .set({ out: published });
  return { ...preparedOf(tx), published };
};

/** Reads each of `reads` and sends a request to the public-only sink. */
const send = (
  runtime: Runtime,
  reads: readonly (readonly [cause: string, path: readonly string[]])[],
): Prepared => {
  const tx = runtime.edit();
  for (const [cause, path] of reads) {
    runtime.getCell(space, cause, undefined, tx).key(...(path as [string]))
      .getRaw();
  }
  enqueueSinkRequestPostCommitEffect(
    tx,
    SINK,
    `${SINK}:release-gate`,
    createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
    `${SINK}-start`,
    () => {},
  );
  return preparedOf(tx);
};

const refusedByCeiling = ({ reasons }: Prepared): boolean =>
  reasons.some((reason) => reason.includes("maxConfidentiality failed"));

const refusedAtSink = ({ reasons }: Prepared): boolean =>
  reasons.some((reason) =>
    reason.includes(`sink-request confidentiality exceeds ceiling for ${SINK}`)
  );

describe("release-gate integrity", () => {
  describe("under the integrity union", () => {
    // What the gates release today: they pool the integrity of everything an
    // access consumed, so the tally's `TransformedBy` at `/a` releases the
    // room clause Alice's copied note carries at `/b`. Each release below is
    // the behavior to remove; the controls beside them show the secret read
    // on its own is refused.

    describe("at the write input gate", () => {
      it("releases a secret written beside an endorsed output, read whole", async () => {
        await withRuntime(async (runtime) => {
          await seedSharedRoom(runtime);
          const result = publish(runtime, "shared");
          expect(result.reasons).toEqual([]);
          expect(result.published).toBe('{"a":"1","b":"alice-secret"}');
        });
      });

      it("refuses the secret read on its own", async () => {
        await withRuntime(async (runtime) => {
          await seedSharedRoom(runtime);
          expect(refusedByCeiling(publish(runtime, "shared", ["b"]))).toBe(
            true,
          );
        });
      });

      it("releases the endorsed output read on its own", async () => {
        await withRuntime(async (runtime) => {
          await seedSharedRoom(runtime);
          expect(publish(runtime, "shared", ["a"]).reasons).toEqual([]);
        });
      });
    });

    describe("at sink egress", () => {
      it("releases a secret read beside an endorsed output in another document", async () => {
        await withRuntime(async (runtime) => {
          await seedBallot(runtime);
          expect(
            refusedAtSink(
              send(runtime, [["ballot", []], ["alice-note", []]]),
            ),
          ).toBe(false);
        });
      });

      it("releases a secret written beside an endorsed output, read whole", async () => {
        await withRuntime(async (runtime) => {
          await seedSharedRoom(runtime);
          expect(refusedAtSink(send(runtime, [["shared", []]]))).toBe(false);
        });
      });

      it("refuses the secret read on its own", async () => {
        await withRuntime(async (runtime) => {
          await seedBallot(runtime);
          expect(refusedAtSink(send(runtime, [["alice-note", []]]))).toBe(
            true,
          );
        });
      });

      it("releases the endorsed output read on its own", async () => {
        await withRuntime(async (runtime) => {
          await seedBallot(runtime);
          expect(refusedAtSink(send(runtime, [["ballot", []]]))).toBe(false);
        });
      });
    });
  });
});

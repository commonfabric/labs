import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { AtomPattern } from "../src/cfc/atom-pattern.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import type { CfcPolicyRecordInput } from "../src/cfc/policy.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// An endorsed transformer's output is released by an exchange rule guarded on
// the `TransformedBy` atom the runtime mints for it. Naming only the code that
// wrote the output lets any caller of that code choose what it computes over:
// an unendorsed derivation reshapes a secret into input the endorsed code
// accepts, the endorsed code writes, and the rule releases the result. These
// cases pin the witness-bearing form, `TransformedBy{identity, inputWitness}`,
// which additionally states what wrote every confidential input the
// transformation consumed, and the laundering shapes it has to refuse.

const signer = await Identity.fromPassphrase("runner-cfc-input-witness");
const space = signer.did();

// The room clause names the room's own space: its members are the audience a
// document living there already reaches, so the writer-fit gate admits the
// room's own writes and only the ceiling below stands in the way.
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
const ATTACKER = verified("module:attacker", "bitOfNote");
const OTHER = verified("module:attacker", "helper");

const transformedBy = (identity: ImplementationIdentity) => ({
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: {
    kind: "verified",
    moduleIdentity: (identity as { moduleIdentity: string }).moduleIdentity,
    symbol: (identity as { symbol: string }).symbol,
  },
});

// The guard existing rules are written with: which code wrote the value.
const IDENTITY_GUARD: AtomPattern = transformedBy(TALLY);

// The witnessed guard: the tally wrote it, and everything confidential the
// tally read was written by the commit step.
const WITNESSED_GUARD: AtomPattern = {
  ...transformedBy(TALLY),
  inputWitness: transformedBy(COMMIT),
};

const releaseRule = (guard: AtomPattern): CfcPolicyRecordInput[] => [{
  id: "conclave-release",
  rules: [{
    id: "release-ballot",
    appliesTo: ROOM,
    preCondition: { integrity: [guard] },
    post: { dropClause: true },
  }],
}];

// The room-visible store: it may hold only public values, so a write into it
// consumes the maxConfidentiality gate, where the rule gets its chance.
const ROOM_STORE_SCHEMA = {
  type: "object",
  ifc: { confidentiality: [ROOM] },
  properties: {
    out: { type: "string", ifc: { maxConfidentiality: [] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SELECTION_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { votes: { type: "array", items: { type: "string" } } },
  },
} as const satisfies JSONSchema;

type Harness = {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
};

const withRuntime = async (
  guard: AtomPattern,
  body: (harness: Harness) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcFlowLabels: "persist",
    cfcPolicyRecords: releaseRule(guard),
    cfcPolicyEvaluation: "enforce",
  });
  try {
    await body({ runtime, storageManager });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

const idOf = (runtime: Runtime, cause: string): string => {
  const tx = runtime.edit();
  const id = runtime.getCell(space, cause, undefined, tx)
    .getAsNormalizedFullLink().id;
  tx.abort();
  return id;
};

/** A room-confidential document holding one member's sealed note. */
const seedSecret = async (
  runtime: Runtime,
  cause: string,
  note: string,
): Promise<void> => {
  const seed = runtime.edit();
  const id = runtime.getCell(space, cause, undefined, seed)
    .getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
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
  expect((await seed.commit()).ok).toBeDefined();
};

/** A public document: no label at all. */
const seedPublic = async (
  runtime: Runtime,
  cause: string,
  value: unknown,
): Promise<void> => {
  const tx = runtime.edit();
  const id = runtime.getCell(space, cause, undefined, tx)
    .getAsNormalizedFullLink().id;
  tx.writeOrThrow({ space, scope: "space", id, path: ["value"] }, value);
  expect((await tx.commit()).ok).toBeDefined();
};

/**
 * One transformation: a transaction under `identity` that reads every input
 * and writes what `compute` makes of them at `path` of the output. The write
 * is raw so the output's own prior value is not journaled as an input.
 */
const transform = async (
  runtime: Runtime,
  identity: ImplementationIdentity | readonly ImplementationIdentity[],
  inputs: readonly string[],
  output: string,
  compute: (values: unknown[]) => unknown,
  path: readonly string[] = [],
): Promise<void> => {
  const identities = Array.isArray(identity) ? identity : [identity];
  const tx = runtime.edit();
  tx.setCfcImplementationIdentity(identities[0]);
  const values = inputs.map((cause) =>
    runtime.getCell(space, cause, undefined, tx).getRaw()
  );
  const id = runtime.getCell(space, output, undefined, tx)
    .getAsNormalizedFullLink().id;
  tx.writeOrThrow(
    { space, scope: "space", id, path: ["value", ...path] },
    compute(values) as never,
  );
  // A second identity writing in the same transaction leaves the whole
  // transaction unattributed (`CfcTxState.writeIdentity`).
  for (const other of identities.slice(1)) {
    tx.setCfcImplementationIdentity(other);
    const scratch = runtime.getCell(space, `${output}-scratch`, undefined, tx)
      .getAsNormalizedFullLink().id;
    tx.writeOrThrow({ space, scope: "space", id: scratch, path: ["value"] }, 1);
  }
  tx.prepareCfc();
  const result = await tx.commit();
  expect(result.error).toBeUndefined();
};

/**
 * Copies `input` into the room-visible store and reports why prepare refused
 * the write, if it did.
 */
const publish = (runtime: Runtime, input: string): readonly string[] => {
  const tx = runtime.edit();
  const value = runtime.getCell(space, input, undefined, tx).getRaw();
  runtime.getCell(space, `${input}-room-store`, ROOM_STORE_SCHEMA, tx)
    .set({ out: String(value) });
  tx.prepareCfc();
  const state = tx.getCfcState();
  const reasons = state.prepare.status === "invalidated"
    ? [...state.prepare.reasons]
    : [];
  tx.abort();
  return reasons;
};

const refusedByCeiling = (reasons: readonly string[]): boolean =>
  reasons.some((reason) => reason.includes("maxConfidentiality failed"));

const storedIntegrity = (runtime: Runtime, cause: string): unknown[] => {
  const tx = runtime.edit();
  const cell = runtime.getCell(space, cause, undefined, tx);
  const metadata = readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink());
  tx.abort();
  return (metadata?.labelMap.entries ?? []).flatMap((entry) =>
    entry.label.integrity ?? []
  );
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

/** The honest path: the commit step seals the room's stances into one doc. */
const commitStances = (runtime: Runtime, output = "committed") =>
  transform(runtime, COMMIT, ["alice-note", "bob-note"], output, () => ({
    votes: ["approve", "reject"],
  }));

/** The laundering step: bit 0 of Alice's note as a one-vote ballot. */
const bitOfAlicesNote = (runtime: Runtime, output = "crafted") =>
  transform(runtime, ATTACKER, ["alice-note"], output, ([alice]) => ({
    votes: [
      ((alice as { note: string }).note.charCodeAt(0) & 1)
        ? "approve"
        : "reject",
    ],
  }));

const seedRoom = async (runtime: Runtime): Promise<void> => {
  await seedSecret(runtime, "alice-note", "alice-secret");
  await seedSecret(runtime, "bob-note", "bob-secret");
};

describe("TransformedBy input witnesses", () => {
  describe("minting", () => {
    it("names what wrote every confidential input beside the transformer", async () => {
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        await transform(runtime, TALLY, ["committed"], "ballot", tally);

        const integrity = storedIntegrity(runtime, "ballot");
        expect(integrity).toContainEqual({
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: TALLY,
        });
        expect(integrity).toContainEqual({
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: TALLY,
          inputWitness: { type: CFC_ATOM_TYPE.TransformedBy, identity: COMMIT },
        });
      });
    });

    it("mints no witness when a confidential input was written by other code", async () => {
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        await bitOfAlicesNote(runtime);
        await transform(
          runtime,
          TALLY,
          ["committed", "crafted"],
          "ballot",
          tally,
        );

        const integrity = storedIntegrity(runtime, "ballot");
        expect(integrity).toContainEqual({
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: TALLY,
        });
        expect(
          integrity.some((atom) =>
            (atom as { inputWitness?: unknown }).inputWitness !== undefined
          ),
        ).toBe(false);
      });
    });
  });

  describe("an identity-only guard", () => {
    // What a rule guarded on the writer alone admits. The first case is the
    // endorsed path; the second is the laundering this primitive exists for,
    // pinned so a rule author can see why the identity alone is not enough.
    // Both stay admitted: the witness is additive, and existing guards keep
    // matching the identity-only atom.
    it("releases the endorsed transformer's output", async () => {
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        await transform(runtime, TALLY, ["committed"], "ballot", tally);
        expect(publish(runtime, "ballot")).toEqual([]);
      });
    });

    it("also releases a secret laundered through the endorsed transformer", async () => {
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await bitOfAlicesNote(runtime);
        await transform(runtime, TALLY, ["crafted"], "ballot", tally);
        expect(publish(runtime, "ballot")).toEqual([]);
      });
    });
  });

  describe("a witnessed guard", () => {
    it("releases the endorsed transformer's output over committed inputs", async () => {
      await withRuntime(WITNESSED_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        await transform(runtime, TALLY, ["committed"], "ballot", tally);
        expect(publish(runtime, "ballot")).toEqual([]);
      });
    });

    it("releases when the transformer also reads public inputs", async () => {
      await withRuntime(WITNESSED_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await seedPublic(runtime, "ballot-options", { options: ["a", "b"] });
        await commitStances(runtime);
        await transform(
          runtime,
          TALLY,
          ["committed", "ballot-options"],
          "ballot",
          tally,
        );
        expect(publish(runtime, "ballot")).toEqual([]);
      });
    });

    it("refuses a secret laundered through the endorsed transformer", async () => {
      await withRuntime(WITNESSED_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await bitOfAlicesNote(runtime);
        await transform(runtime, TALLY, ["crafted"], "ballot", tally);
        expect(refusedByCeiling(publish(runtime, "ballot"))).toBe(true);
      });
    });

    it("refuses when a crafted input is mixed in with committed ones", async () => {
      await withRuntime(WITNESSED_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        await bitOfAlicesNote(runtime);
        await transform(
          runtime,
          TALLY,
          ["committed", "crafted"],
          "ballot",
          tally,
        );
        expect(refusedByCeiling(publish(runtime, "ballot"))).toBe(true);
      });
    });

    it("refuses when a transformer read a secret directly", async () => {
      await withRuntime(WITNESSED_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        await transform(
          runtime,
          TALLY,
          ["committed", "alice-note"],
          "ballot",
          tally,
        );
        expect(refusedByCeiling(publish(runtime, "ballot"))).toBe(true);
      });
    });

    it("refuses a crafted value written beside a committed one in the same input", async () => {
      // The input document holds a committed value at one path and a crafted
      // one at another. Integrity on the committed path says nothing about
      // the crafted one, so the input as read carries no witness.
      await withRuntime(WITNESSED_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await transform(
          runtime,
          COMMIT,
          ["alice-note", "bob-note"],
          "shared",
          () => ["approve", "reject"],
          ["committed"],
        );
        await transform(
          runtime,
          ATTACKER,
          ["alice-note"],
          "shared",
          ([alice]) => [(alice as { note: string }).note.slice(0, 1)],
          ["votes"],
        );
        await transform(runtime, TALLY, ["shared"], "ballot", tally);
        expect(refusedByCeiling(publish(runtime, "ballot"))).toBe(true);
      });
    });

    it("refuses a secret-chosen selection of committed documents", async () => {
      // Every document the tally reads was written by the commit step, but
      // which of them it reads was chosen from Alice's note: the list of
      // references is the attacker's write, and reading through it observes
      // that choice. A reference slot's label carries the link's provenance
      // and no `TransformedBy`, so a list of references is refused whoever
      // wrote it; this pins that the choice is not skipped as plumbing.
      await withRuntime(WITNESSED_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime, "committed-a");
        await transform(
          runtime,
          COMMIT,
          ["alice-note", "bob-note"],
          "committed-b",
          () => ({ votes: ["reject"] }),
        );
        const tx = runtime.edit();
        tx.setCfcImplementationIdentity(ATTACKER);
        const alice = runtime.getCell(space, "alice-note", undefined, tx)
          .getRaw() as { note: string };
        const chosen = runtime.getCell(
          space,
          alice.note.charCodeAt(0) & 1 ? "committed-a" : "committed-b",
          undefined,
          tx,
        );
        runtime.getCell(space, "selection", SELECTION_SCHEMA, tx).set([
          chosen,
        ] as never);
        tx.prepareCfc();
        expect((await tx.commit()).error).toBeUndefined();

        const tallyTx = runtime.edit();
        tallyTx.setCfcImplementationIdentity(TALLY);
        const selected = runtime.getCell(
          space,
          "selection",
          SELECTION_SCHEMA,
          tallyTx,
        ).get() as unknown[];
        const ballotId = runtime.getCell(space, "ballot", undefined, tallyTx)
          .getAsNormalizedFullLink().id;
        tallyTx.writeOrThrow(
          { space, scope: "space", id: ballotId, path: ["value"] },
          tally(selected),
        );
        tallyTx.prepareCfc();
        expect((await tallyTx.commit()).error).toBeUndefined();

        expect(refusedByCeiling(publish(runtime, "ballot"))).toBe(true);
      });
    });

    it("refuses an input whose writer is unattributed", async () => {
      await withRuntime(WITNESSED_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await transform(
          runtime,
          [COMMIT, OTHER],
          ["alice-note"],
          "crafted",
          ([alice]) => ({
            votes: [(alice as { note: string }).note.slice(0, 1)],
          }),
        );
        await transform(runtime, TALLY, ["crafted"], "ballot", tally);
        expect(refusedByCeiling(publish(runtime, "ballot"))).toBe(true);
      });
    });
  });

  describe("chains of endorsed transformers", () => {
    // The commit step is endorsed code too, so a caller can feed IT crafted
    // input. A guard pinning one level trusts whatever the commit step was
    // fed; a guard pinning the commit step's own witness does not.
    const SUBMIT = verified("module:conclave", "submitStance");
    const pinsChain: AtomPattern = {
      ...transformedBy(TALLY),
      inputWitness: {
        ...transformedBy(COMMIT),
        inputWitness: transformedBy(SUBMIT),
      },
    };

    // Each member's stance is born in the room: the submit step reads the
    // room's roster (so its write is attributed) and writes the stance.
    const submitStances = async (runtime: Runtime): Promise<void> => {
      await seedSecret(runtime, "roster", "members");
      for (const [who, vote] of [["alice", "approve"], ["bob", "reject"]]) {
        await transform(runtime, SUBMIT, ["roster"], `${who}-stance`, () => ({
          vote,
        }));
      }
    };

    const commitSubmitted = (runtime: Runtime, inputs: readonly string[]) =>
      transform(runtime, COMMIT, inputs, "committed", (values) => ({
        votes: values.flatMap((value) => {
          const { vote, votes } = value as { vote?: string; votes?: string[] };
          return vote === undefined ? votes ?? [] : [vote];
        }),
      }));

    it("records the inner transformer's witness inside the outer one", async () => {
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await submitStances(runtime);
        await commitSubmitted(runtime, ["alice-stance", "bob-stance"]);
        await transform(runtime, TALLY, ["committed"], "ballot", tally);

        expect(storedIntegrity(runtime, "ballot")).toContainEqual({
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: TALLY,
          inputWitness: {
            type: CFC_ATOM_TYPE.TransformedBy,
            identity: COMMIT,
            inputWitness: {
              type: CFC_ATOM_TYPE.TransformedBy,
              identity: SUBMIT,
            },
          },
        });
      });
    });

    it("a guard pinning the chain releases the endorsed chain", async () => {
      await withRuntime(pinsChain, async ({ runtime }) => {
        await submitStances(runtime);
        await commitSubmitted(runtime, ["alice-stance", "bob-stance"]);
        await transform(runtime, TALLY, ["committed"], "ballot", tally);
        expect(publish(runtime, "ballot")).toEqual([]);
      });
    });

    it("a guard pinning the chain refuses crafted input fed to the inner step", async () => {
      await withRuntime(pinsChain, async ({ runtime }) => {
        await submitStances(runtime);
        await seedRoom(runtime);
        await bitOfAlicesNote(runtime);
        await commitSubmitted(runtime, ["crafted"]);
        await transform(runtime, TALLY, ["committed"], "ballot", tally);
        expect(refusedByCeiling(publish(runtime, "ballot"))).toBe(true);
      });
    });

    it("a guard pinning one level admits crafted input fed to the inner step", async () => {
      // Every value the commit step writes carries the commit step's
      // identity-only atom, whatever it was fed, so a one-level pin is
      // satisfied by it. A rule pins as deep as the code it trusts.
      await withRuntime(WITNESSED_GUARD, async ({ runtime }) => {
        await submitStances(runtime);
        await seedRoom(runtime);
        await bitOfAlicesNote(runtime);
        await commitSubmitted(runtime, ["crafted"]);
        await transform(runtime, TALLY, ["committed"], "ballot", tally);
        expect(publish(runtime, "ballot")).toEqual([]);
      });
    });
  });

  describe("the room's committed document", () => {
    it("is attributed to the commit step", async () => {
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        expect(storedIntegrity(runtime, "committed")).toContainEqual({
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: COMMIT,
        });
        expect(idOf(runtime, "committed")).toBeDefined();
      });
    });
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  CFC_ATOM_TYPE,
  type CfcAtom,
  cfcAtom,
  type CfcTransformedByInput,
} from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createRef } from "../src/create-ref.ts";
import type { AtomPattern } from "../src/cfc/atom-pattern.ts";
import { transformedByOperation } from "../src/cfc/implementation-identity.ts";
import type {
  ImplementationIdentity,
  LabelMapEntry,
} from "../src/cfc/types.ts";
import type { CfcPolicyRecordInput } from "../src/cfc/policy.ts";
import {
  INPUT_WITNESS_MAX_DEPTH,
  inputWitnessDepth,
  mintTransformedBy,
  retainedInputWitnesses,
} from "../src/cfc/input-witness.ts";
import { canonicalizeTransformedByInputs } from "../src/cfc/canonical.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { toURI } from "../src/uri-utils.ts";

// An endorsed transformer's output is released by an exchange rule guarded on
// the `TransformedBy` atom the runtime mints for it. Naming only the code that
// wrote the output lets any caller of that code choose what it computes over:
// an unendorsed derivation reshapes a secret into input the endorsed code
// accepts, the endorsed code writes, and the rule releases the result. These
// cases pin the exact input record and its witnesses, which additionally
// state what wrote each confidential input the transformation consumed, and
// the laundering shapes it has to refuse.

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
  ...transformedByOperation(identity)!,
});

const inputRef = (cause: string, path: readonly string[] = []) => ({
  space,
  id: toURI(createRef({}, cause)),
  path,
});

const witnessedInput = (
  cause: string,
  writer: ImplementationIdentity = COMMIT,
) => ({
  ref: inputRef(cause),
  witnesses: [{ ...transformedBy(writer) }],
});

const exactTransformedBy = (
  identity: ImplementationIdentity,
  inputs: readonly CfcTransformedByInput[] = [],
) => mintTransformedBy(transformedByOperation(identity)!, inputs);

// The guard existing rules are written with: which operation wrote the value.
const IDENTITY_GUARD: AtomPattern = transformedBy(TALLY);

const guardForInputs = (
  inputs: readonly CfcTransformedByInput[],
): AtomPattern => ({
  ...transformedBy(TALLY),
  inputs: canonicalizeTransformedByInputs(inputs),
});

// The witnessed guard: the tally wrote it, and everything confidential the
// tally read was written by the commit step.
const WITNESSED_GUARD = guardForInputs([witnessedInput("committed")]);

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
  expect((await seed.commit()).ok).toBeDefined();
};

/** A room-confidential document holding one member's sealed note. */
const seedSecret = (
  runtime: Runtime,
  cause: string,
  note: string,
): Promise<void> =>
  seedLabeled(runtime, cause, { note }, [
    { path: [], label: { confidentiality: [ROOM] } },
  ]);

/** A public document: no label at all. */
const seedPublic = async (
  runtime: Runtime,
  cause: string,
  value: FabricValue,
): Promise<void> => {
  const tx = runtime.edit();
  const id = runtime.getCell(space, cause, undefined, tx)
    .getAsNormalizedFullLink().id;
  tx.writeOrThrow({ space, scope: "space", id, path: ["value"] }, value);
  expect((await tx.commit()).ok).toBeDefined();
};

/**
 * One transformation: a transaction under `identity` that reads every input,
 * lets `observe` consume anything else, and writes what `compute` makes of the
 * inputs at `path` of the output. The write is raw so the output's own prior
 * value is not journaled as an input.
 */
const transform = async (
  runtime: Runtime,
  identity: ImplementationIdentity | readonly ImplementationIdentity[],
  inputs: readonly string[],
  output: string,
  compute: (values: unknown[]) => FabricValue,
  path: readonly string[] = [],
  observe?: (tx: IExtendedStorageTransaction) => void | Promise<void>,
): Promise<void> => {
  const identities = Array.isArray(identity) ? identity : [identity];
  const tx = runtime.edit();
  tx.setCfcImplementationIdentity(identities[0]);
  const values = inputs.map((cause) =>
    runtime.getCell(space, cause, undefined, tx).getRaw()
  );
  await observe?.(tx);
  const id = runtime.getCell(space, output, undefined, tx)
    .getAsNormalizedFullLink().id;
  tx.writeOrThrow(
    { space, scope: "space", id, path: ["value", ...path] },
    compute(values),
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
    it("names each input reference and its retained witnesses", async () => {
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        await transform(runtime, TALLY, ["committed"], "ballot", tally);

        const integrity = storedIntegrity(runtime, "ballot");
        const commitAtom = exactTransformedBy(COMMIT, [
          { ref: inputRef("alice-note") },
          { ref: inputRef("bob-note") },
        ]);
        expect(integrity).toContainEqual(exactTransformedBy(TALLY, [{
          ref: inputRef("committed"),
          witnesses: [commitAtom],
        }]));
      });
    });

    it("keeps distinct witness sets on distinct input references", async () => {
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
        const [atom] = integrity.filter((candidate) =>
          (candidate as { operation?: unknown }).operation === "tallyBallot"
        ) as Array<{ inputs: CfcTransformedByInput[] }>;
        expect(atom.inputs.map((input) => input.ref)).toEqual(
          canonicalizeTransformedByInputs([
            { ref: inputRef("committed") },
            { ref: inputRef("crafted") },
          ]).map((input) => input.ref),
        );
        expect(
          atom.inputs.map((input) =>
            input.witnesses?.map((witness) =>
              (witness as { operation?: unknown }).operation
            )
          ),
        ).toEqual(
          atom.inputs.map((input) =>
            input.ref.id === inputRef("committed").id
              ? ["commitStances"]
              : ["bitOfNote"]
          ),
        );
      });
    });
  });

  describe("an operation-only guard", () => {
    // What a rule guarded on the writer alone admits. The first case is the
    // endorsed path; the second is the laundering this primitive exists for,
    // pinned so a rule author can see why the identity alone is not enough.
    // Both stay admitted: the witness is additive, and existing guards keep
    // matching the exact atom by its operation fields.
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
      const guard = guardForInputs([
        witnessedInput("committed"),
        { ref: inputRef("ballot-options") },
      ]);
      await withRuntime(guard, async ({ runtime }) => {
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
      const guard = guardForInputs([
        witnessedInput("committed"),
        witnessedInput("crafted"),
      ]);
      await withRuntime(guard, async ({ runtime }) => {
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
      const guard = guardForInputs([
        witnessedInput("committed"),
        witnessedInput("alice-note"),
      ]);
      await withRuntime(guard, async ({ runtime }) => {
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
    const commitPattern = {
      ...transformedBy(COMMIT),
      inputs: canonicalizeTransformedByInputs([
        witnessedInput("alice-stance", SUBMIT),
        witnessedInput("bob-stance", SUBMIT),
      ]),
    };
    const pinsChain = guardForInputs([{
      ref: inputRef("committed"),
      witnesses: [commitPattern],
    }]);

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

        const submitAtom = exactTransformedBy(SUBMIT, [{
          ref: inputRef("roster"),
        }]);
        const commitAtom = exactTransformedBy(COMMIT, [
          {
            ref: inputRef("alice-stance"),
            witnesses: [submitAtom],
          },
          {
            ref: inputRef("bob-stance"),
            witnesses: [submitAtom],
          },
        ]);
        expect(storedIntegrity(runtime, "ballot")).toContainEqual(
          exactTransformedBy(TALLY, [{
            ref: inputRef("committed"),
            witnesses: [commitAtom],
          }]),
        );
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
      // Every value the commit step writes carries the commit operation,
      // whatever it was fed, so a one-level pin is
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
        expect(storedIntegrity(runtime, "committed")).toContainEqual(
          exactTransformedBy(COMMIT, [
            { ref: inputRef("alice-note") },
            { ref: inputRef("bob-note") },
          ]),
        );
      });
    });
  });

  describe("what fails closed", () => {
    // Each case pairs a control, where the witness is minted, with the same
    // transformation over an input that violates one guard, where it must not
    // be. The control keeps the refusal from passing for an unrelated reason.
    const tb = (identity: ImplementationIdentity) =>
      exactTransformedBy(identity);
    const COMMITTED_VALUE = (integrity: CfcAtom[]): LabelMapEntry => ({
      path: [],
      origin: "derived",
      observes: "value",
      label: { confidentiality: [ROOM], integrity },
    });
    const DECLARED_ROOM: LabelMapEntry = {
      path: [],
      origin: "declared",
      label: { confidentiality: [ROOM] },
    };
    const witnessesOf = (runtime: Runtime, cause: string): unknown[] =>
      storedIntegrity(runtime, cause).flatMap((atom) => {
        const inputs = (atom as { inputs?: CfcTransformedByInput[] }).inputs;
        return inputs?.flatMap((input) => input.witnesses ?? []) ?? [];
      });

    const inputsOf = (
      runtime: Runtime,
      cause: string,
    ): readonly CfcTransformedByInput[] => {
      const atom = storedIntegrity(runtime, cause).find((candidate) =>
        (candidate as { type?: unknown }).type === CFC_ATOM_TYPE.TransformedBy
      ) as { inputs?: CfcTransformedByInput[] } | undefined;
      return atom?.inputs ?? [];
    };
    const witnessOperationsOf = (runtime: Runtime, cause: string): unknown[] =>
      witnessesOf(runtime, cause).map((witness) =>
        (witness as { operation?: unknown }).operation
      );

    it("a witnessed child does not vouch for an unwitnessed `*` slot beside it", async () => {
      // The `*` slot stands for the children with no entry of their own, and
      // its own resolution carries no witness. The concrete sibling's entry
      // resolves at the sibling alone.
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        const witnessed = [
          DECLARED_ROOM,
          COMMITTED_VALUE([tb(COMMIT)]),
          {
            path: ["items", "a"],
            origin: "derived",
            observes: "value",
            label: { confidentiality: [ROOM], integrity: [tb(COMMIT)] },
          },
        ] satisfies LabelMapEntry[];
        const value = { items: { a: "approve", b: "approve" } };
        await seedLabeled(runtime, "slots-control", value, witnessed);
        await seedLabeled(runtime, "slots", value, [...witnessed, {
          path: ["items", "*"],
          origin: "derived",
          observes: "value",
          label: { confidentiality: [ROOM] },
        }]);
        await transform(runtime, TALLY, ["slots-control"], "control", tally);
        await transform(runtime, TALLY, ["slots"], "ballot", tally);

        expect(witnessesOf(runtime, "control")).toEqual([tb(COMMIT)]);
        expect(witnessesOf(runtime, "ballot")).toEqual([]);
      });
    });

    it("a runtime-minted `*` template's integrity witnesses nothing", async () => {
      // The template shadows the witnessed value above it in replace-down,
      // and its own `TransformedBy` labels membership, not a written value.
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        const witnessed = [DECLARED_ROOM, COMMITTED_VALUE([tb(COMMIT)])];
        const value = { items: { a: "approve" } };
        await seedLabeled(runtime, "template-control", value, witnessed);
        await seedLabeled(runtime, "template", value, [...witnessed, {
          path: ["items", "*"],
          origin: "derived",
          observes: "value",
          label: { confidentiality: [ROOM], integrity: [tb(COMMIT)] },
        }]);
        await transform(runtime, TALLY, ["template-control"], "control", tally);
        await transform(runtime, TALLY, ["template"], "ballot", tally);

        expect(witnessesOf(runtime, "control")).toEqual([tb(COMMIT)]);
        expect(witnessesOf(runtime, "ballot")).toEqual([]);
      });
    });

    it("does not represent a label-metadata observation as a content input", async () => {
      // The observation is recorded through the transaction's channel
      // directly, as `inspectStoredConfLabel` records one for a protected
      // result. It affects confidentiality but is not a consumed content ref.
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        await transform(runtime, TALLY, ["committed"], "control", tally);
        await transform(
          runtime,
          TALLY,
          ["committed"],
          "ballot",
          tally,
          [],
          (tx) => {
            const { id } = runtime.getCell(space, "committed", undefined, tx)
              .getAsNormalizedFullLink();
            tx.recordCfcLabelMetadataObservation({
              target: {
                space,
                id,
                scope: "space",
                path: ["cfc", "labels", "value", "votes"],
              },
              observes: "labelMetadata",
              confidentiality: [ROOM],
            });
          },
        );

        expect(witnessOperationsOf(runtime, "control")).toEqual([
          "commitStances",
        ]);
        expect(witnessOperationsOf(runtime, "ballot")).toEqual([
          "commitStances",
        ]);
        expect(inputsOf(runtime, "ballot")).toHaveLength(1);
      });
    });

    it("keeps an external content input distinct when it has no witness", async () => {
      // A host-observed row is a content input like any read. It receives its
      // own reference rather than erasing evidence held by another input.
      const PRODUCER = "input-witness-producer";
      const producer: ImplementationIdentity = {
        kind: "builtin",
        builtinId: PRODUCER,
      };
      const ROW_SCHEMA = {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        ifc: { confidentiality: [ROOM] },
      } as const satisfies JSONSchema;
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await seedRoom(runtime);
        await commitStances(runtime);
        await transform(runtime, producer, ["committed"], "control", tally);
        await transform(
          runtime,
          producer,
          ["committed"],
          "ballot",
          tally,
          [],
          async (tx) => {
            const receipt = await runtime.prepareExternalContentObservation({
              targetTx: tx,
              space,
              cause: "input-witness-external-row",
              schema: ROW_SCHEMA,
              value: { title: "host row" },
              producer: PRODUCER,
            });
            runtime.recordExternalContentObservation(tx, receipt, {
              space,
              producer: PRODUCER,
            });
            const [observation] = tx.getCfcState().externalContentObservations;
            expect(observation.flow.confidentiality).toContainEqual(ROOM);
          },
        );

        expect(witnessOperationsOf(runtime, "control")).toEqual([
          "commitStances",
        ]);
        expect(witnessOperationsOf(runtime, "ballot")).toEqual([
          "commitStances",
        ]);
        const inputs = inputsOf(runtime, "ballot");
        expect(inputs).toHaveLength(2);
        expect(
          inputs.find((input) => input.ref.id === inputRef("committed").id)
            ?.witnesses?.map((witness) =>
              (witness as { operation?: unknown }).operation
            ),
        ).toEqual(["commitStances"]);
        expect(
          inputs.find((input) => input.ref.id !== inputRef("committed").id)
            ?.witnesses,
        ).toBeUndefined();
      });
    });

    it("a chain of five endorsed steps records at most three levels", async () => {
      // Each step nests the previous step's atoms one level deeper, so an
      // uncapped chain would carry four levels at the fifth step.
      const steps = ["submit", "commit", "tally", "audit", "archive"].map((
        symbol,
      ) => verified("module:conclave", symbol));
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        await seedSecret(runtime, "roster", "members");
        let input = "roster";
        for (const [index, step] of steps.entries()) {
          await transform(runtime, step, [input], `step-${index}`, () => ({
            votes: ["approve"],
          }));
          input = `step-${index}`;
        }
        const depths = storedIntegrity(runtime, input).map((atom) =>
          inputWitnessDepth(atom as CfcAtom)
        );
        expect(Math.max(...depths)).toBe(INPUT_WITNESS_MAX_DEPTH);
      });
    });

    it("stamps the same label whatever order the witnesses were read in", async () => {
      await withRuntime(IDENTITY_GUARD, async ({ runtime }) => {
        const SUBMIT = verified("module:conclave", "submitStance");
        const value = { votes: ["approve"] };
        await seedLabeled(runtime, "pair-ab", value, [
          DECLARED_ROOM,
          COMMITTED_VALUE([tb(COMMIT), tb(SUBMIT)]),
        ]);
        await seedLabeled(runtime, "pair-ba", value, [
          DECLARED_ROOM,
          COMMITTED_VALUE([tb(SUBMIT), tb(COMMIT)]),
        ]);
        await transform(runtime, TALLY, ["pair-ab", "pair-ba"], "ab", tally);
        await transform(runtime, TALLY, ["pair-ba", "pair-ab"], "ba", tally);

        expect(witnessesOf(runtime, "ab")).toHaveLength(4);
        expect(JSON.stringify(storedIntegrity(runtime, "ba"))).toBe(
          JSON.stringify(storedIntegrity(runtime, "ab")),
        );
      });
    });
  });

  describe("mintTransformedBy", () => {
    const A = exactTransformedBy(COMMIT);
    const B = exactTransformedBy(OTHER);

    it("orders input references and witnesses canonically", () => {
      const first: CfcTransformedByInput[] = [
        { ref: inputRef("b"), witnesses: [B, A] },
        { ref: inputRef("a") },
      ];
      const second: CfcTransformedByInput[] = [
        { ref: inputRef("a") },
        { ref: inputRef("b"), witnesses: [A, B] },
      ];
      expect(
        JSON.stringify(
          mintTransformedBy(transformedByOperation(TALLY)!, first),
        ),
      ).toBe(
        JSON.stringify(
          mintTransformedBy(transformedByOperation(TALLY)!, second),
        ),
      );
    });

    it("deduplicates one reference by meeting its witness observations", () => {
      const atom = mintTransformedBy(transformedByOperation(TALLY)!, [
        { ref: inputRef("same"), witnesses: [A, { ...A }, B] },
        { ref: inputRef("same"), witnesses: [A] },
      ]);
      expect(atom.inputs).toEqual([{
        ref: inputRef("same"),
        witnesses: [A],
      }]);
    });

    it("truncates a retained witness so the next mint stays at the cap", () => {
      let atom: CfcAtom = A;
      for (let depth = 0; depth < INPUT_WITNESS_MAX_DEPTH; depth++) {
        atom = exactTransformedBy(OTHER, [{
          ref: inputRef(`depth-${depth}`),
          witnesses: [atom],
        }]);
      }
      expect(inputWitnessDepth(atom)).toBe(INPUT_WITNESS_MAX_DEPTH);
      const [retained] = retainedInputWitnesses([atom]);
      expect(inputWitnessDepth(retained)).toBe(INPUT_WITNESS_MAX_DEPTH - 1);
    });

    it("treats malformed witness containers as witness-free opaque data", () => {
      const noInputs = {
        type: CFC_ATOM_TYPE.TransformedBy,
        codeHash: "cf:module/malformed",
        inputs: "not-an-array",
      } as unknown as CfcAtom;
      expect(inputWitnessDepth("not-an-atom")).toBe(0);
      expect(inputWitnessDepth(noInputs)).toBe(0);
      expect(retainedInputWitnesses([noInputs])).toEqual([noInputs]);

      const malformedInput = {
        type: CFC_ATOM_TYPE.TransformedBy,
        codeHash: "cf:module/malformed",
        inputs: [null],
      } as unknown as CfcAtom;
      expect(retainedInputWitnesses([malformedInput])).toEqual([
        malformedInput,
      ]);
    });
  });
});

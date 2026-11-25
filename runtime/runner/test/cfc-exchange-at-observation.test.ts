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
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
  type CfcPolicyRecordInput,
} from "../src/cfc/policy.ts";
import type {
  CfcPolicyEvaluationMode,
  ImplementationIdentity,
  LabelMapEntry,
} from "../src/cfc/types.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import { declaredOnwardRead } from "../src/storage/reactivity-log.ts";
import { storedLabelEntries } from "./cfc-stored-labels.ts";

const signer = await Identity.fromPassphrase("runner-cfc-exchange-observation");
const space = signer.did();

const ALICE = "did:key:alice";
const BOB = "did:key:bob";
const EVE = "did:key:eve";

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

/**
 * One computation under `DERIVE` that reads the document `input` shallowly,
 * as a read that stops at a container does, and writes what it saw to
 * `output`. Returns how the commit settled.
 */
const deriveShallow = async (
  runtime: Runtime,
  input: string,
  output: string,
) => {
  const tx = runtime.edit();
  setCfcImplementationIdentity(tx, DERIVE);
  const seen = tx.readOrThrow({
    space,
    scope: "space",
    id: idOf(runtime, input, tx),
    type: "application/json",
    path: ["value"],
  }, { nonRecursive: true });
  tx.writeOrThrow({
    space,
    scope: "space",
    id: idOf(runtime, output, tx),
    path: ["value"],
  }, JSON.stringify(seen));
  tx.prepareCfc();
  return await tx.commit().settled;
};

/** The clauses the value stamp of the document `cause` carries. */
const clausesOf = (runtime: Runtime, cause: string): unknown[] => {
  const tx = runtime.readTx();
  const cfc = tx.readOrThrow({
    space,
    scope: "space",
    id: idOf(runtime, cause, tx),
    path: ["cfc"],
  });
  // A label held by reference names a `cid:` label document.
  const labelDocument = (ref: string) =>
    ref.startsWith("cid:")
      ? tx.readOrThrow({
        space,
        scope: "space",
        id: `cid:${ref.slice("cid:".length)}`,
        path: [],
      })
      : undefined;
  return storedLabelEntries<LabelMapEntry>(cfc, labelDocument)
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

  describe("a shallow read of a list", () => {
    // A read that stops at a container observes how long the list is, and
    // the length's own stamp says who last changed it.

    const seedList = (runtime: Runtime, lengthWriter: ImplementationIdentity) =>
      seed(runtime, "list", ["2-1", "1-2"], [{
        path: [],
        origin: "derived",
        observes: "shape",
        label: { confidentiality: [SEALED] },
      }, {
        path: [],
        origin: "derived",
        observes: "value",
        label: { confidentiality: [SEALED], integrity: [transformedBy(TALLY)] },
      }, {
        path: ["length"],
        origin: "derived",
        observes: "value",
        label: {
          confidentiality: [SEALED],
          integrity: [transformedBy(lengthWriter)],
        },
      }]);

    it("carries no clause where the rule's code wrote the length too", async () => {
      await withRuntime(async (runtime) => {
        await seedList(runtime, TALLY);
        const settled = await deriveShallow(runtime, "list", "derived");
        expect(settled.error).toBeUndefined();
        expect(clausesOf(runtime, "derived")).toEqual([]);
      });
    });

    it("keeps the sealed clause where other code wrote the length", async () => {
      await withRuntime(async (runtime) => {
        await seedList(runtime, OTHER);
        const settled = await deriveShallow(runtime, "list", "derived");
        expect(settled.error).toBeUndefined();
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      });
    });
  });

  describe("a whole read of a list declared onward", () => {
    // What reaches the declared target is what the read consumed at the list
    // itself, its membership included, so the length's stamp counts there
    // too.

    /** The confidentiality the read declares onto its target. */
    const declaredOnto = async (
      lengthWriter: ImplementationIdentity,
    ): Promise<unknown[]> => {
      let declared: unknown[] = [];
      await withRuntime(async (runtime) => {
        await seed(runtime, "list", ["2-1", "1-2"], [{
          path: [],
          origin: "derived",
          observes: "value",
          label: {
            confidentiality: [SEALED],
            integrity: [transformedBy(TALLY)],
          },
        }, {
          path: ["length"],
          origin: "derived",
          observes: "value",
          label: {
            confidentiality: [SEALED],
            integrity: [transformedBy(lengthWriter)],
          },
        }]);
        const tx = runtime.edit();
        tx.runWithAmbientReadMeta(
          declaredOnwardRead({
            space,
            scope: "space",
            id: idOf(runtime, "onto", tx),
            path: [],
          }),
          () => runtime.getCell(space, "list", undefined, tx).getRaw(),
        );
        declared = [...deriveFlowJoin(tx).declaredOnwardAt.values()]
          .flatMap((onward) => onward.confidentiality);
        tx.abort?.();
      });
      return declared;
    };

    it("declares no clause where the rule's code wrote the length too", async () => {
      expect(await declaredOnto(TALLY)).toEqual([]);
    });

    it("declares the sealed clause where other code wrote the length", async () => {
      expect(await declaredOnto(OTHER)).toEqual([SEALED]);
    });
  });

  describe("an evaluation that runs out of fuel", () => {
    // Dropping one alternative of a clause tightens it, so keeping the
    // clauses as read would be the looser label. Each alternative is held on
    // its own instead, which no outcome of the rules is stricter than, and
    // the store, which admits each clause as read, refuses that (§5.3.2).

    const viewers = Array.from({ length: 65 }, (_, i) => `did:key:viewer-${i}`);
    const NARROWING_RULES: CfcPolicyRecordInput[] = [{
      id: "narrow",
      rules: viewers.map((viewer) => ({
        id: `narrow-${viewer}`,
        appliesTo: cfcAtom.user(viewer),
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
      })),
    }];

    it("refuses the derivation rather than join the clauses as read", async () => {
      await withRuntime(async (runtime) => {
        await seed(runtime, "wide", "2-1", [{
          path: [],
          origin: "derived",
          observes: "value",
          label: {
            confidentiality: viewers.map(releasedTo),
            integrity: [transformedBy(TALLY)],
          },
        }]);
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, DERIVE);
        const value = runtime.getCell(space, "wide", undefined, tx).getRaw();
        tx.writeOrThrow({
          space,
          scope: "space",
          id: idOf(runtime, "derived", tx),
          path: ["value"],
        }, JSON.stringify(value));
        tx.prepareCfc();
        const settled = await tx.commit().settled;
        expect(String(settled.error?.message)).toContain("misfit");
        expect(String(settled.error?.message)).toContain(
          JSON.stringify(cfcAtom.user(viewers[0])),
        );
      }, { rules: NARROWING_RULES });
    });

    it("narrows the clauses where the rules converge", async () => {
      await withRuntime(async (runtime) => {
        await seed(runtime, "two", "2-1", [{
          path: [],
          origin: "derived",
          observes: "value",
          label: {
            confidentiality: viewers.slice(0, 2).map(releasedTo),
            integrity: [transformedBy(TALLY)],
          },
        }]);
        await derive(runtime, ["two"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      }, { rules: NARROWING_RULES });
    });
  });

  describe("a module policy named at many locations", () => {
    // The manifest is resolved once for the pass, not once per location: a
    // resolution reads the manifest document and binds it into the commit.

    const artifact = buildCfcPolicyArtifactManifest({
      formatVersion: 1,
      moduleIdentity: "module:table",
      symbol: "rules",
      template: {
        templateVersion: 1,
        exchangeRules: [{
          name: "release-tally",
          preCondition: {
            confidentiality: [{ thisPolicy: true }],
            integrity: [{
              type: CFC_ATOM_TYPE.TransformedBy,
              identity: {
                kind: "verified",
                moduleIdentity: "module:table",
                symbol: "tallyBallot",
              },
            }],
          },
          postCondition: { confidentiality: [], integrity: [] },
        }],
        dependencies: { authorityOnly: [], dataBearing: [] },
        integrityRequirements: {},
      },
    });
    const policyRef = {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: artifact.manifest.moduleIdentity,
      symbol: artifact.manifest.symbol,
      policyDigest: artifact.policyDigest,
    } as const;
    const POLICY = { ...policyRef, subject: space } as CfcAtom;

    /** An integrity atom a flow join carries through its meet. */
    const CERTIFIED = {
      type: "https://commonfabric.org/cfc/atom/PolicyCertified",
    } as CfcAtom;

    /**
     * Derives from `rows` stamped rows; returns the reads of the manifest
     * the transaction made and the integrity two flow joins of it carry.
     */
    const deriveRows = async (
      rows: number,
    ): Promise<{ reads: number; integrity: unknown[][] }> => {
      let reads = 0;
      let integrity: unknown[][] = [];
      await withRuntime(async (runtime) => {
        // A write a schema labels with the policy installs its manifest in
        // the space.
        runtime.registerCfcPolicyManifests(space, [artifact]);
        const install = runtime.edit();
        runtime.getCell(
          space,
          "installs-policy",
          {
            type: "string",
            ifc: {
              confidentiality: [{
                ...policyRef,
                subject: { __ctOwningSpace: true },
              }],
            },
          } as const,
          install,
        ).set("x");
        expect((await install.commit().settled).error).toBeUndefined();
        await seed(
          runtime,
          "rows",
          Array.from({ length: rows }, (_, i) => `row-${i}`),
          Array.from({ length: rows }, (_, i) => ({
            path: [String(i)],
            origin: "derived" as const,
            observes: "value" as const,
            label: {
              confidentiality: [POLICY],
              integrity: [transformedBy(TALLY), CERTIFIED],
            },
          })),
        );
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, DERIVE);
        const value = runtime.getCell(space, "rows", undefined, tx).getRaw();
        tx.writeOrThrow({
          space,
          scope: "space",
          id: idOf(runtime, "derived", tx),
          path: ["value"],
        }, JSON.stringify(value));
        // Prepare joins more than once, so a lookup the first join made
        // must not count as an input of the next.
        integrity = [
          deriveFlowJoin(tx).integrity,
          deriveFlowJoin(tx).integrity,
        ];
        tx.prepareCfc();
        const manifestId = `of:${
          cfcPolicyManifestDocId(artifact.policyDigest)
        }`;
        reads = [...(tx.getReadActivities?.() ?? [])].filter((read) =>
          read.id === manifestId ||
          read.id === cfcPolicyManifestDocId(artifact.policyDigest)
        ).length;
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(clausesOf(runtime, "derived")).toEqual([]);
      }, { rules: [] });
      return { reads, integrity };
    };

    it("reads the manifest as often for many locations as for one", async () => {
      const { reads: one } = await deriveRows(1);
      expect(one).toBeGreaterThan(0);
      expect((await deriveRows(20)).reads).toBe(one);
    });

    it("carries the inputs' shared integrity through every join", async () => {
      const { integrity } = await deriveRows(2);
      for (const joined of integrity) expect(joined).toContainEqual(CERTIFIED);
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

  describe("a forged viewer stamp under the card-table rule", () => {
    // ATTACK (threat-model probes #3, #5, #7). The card-table release rule
    // matches a `TransformedBy{identity: viewFor, inputWitness: move,
    // viewer}` atom and adds `User(viewer)`. These cases ask the evaluator
    // what it checks about that atom before it releases. The atom is plain
    // stored data: the runtime that minted it, the document it is stored in,
    // and the principal the document's scope key names are all absent from
    // the atom and from the rule. So the only protection against a forged
    // stamp is whatever stops the bytes from being stored under the sealed
    // clause in the first place. `seedStamped` writes the label through the
    // privileged persistence scope, standing in for a writer that is not the
    // honest runner write chokepoint (a direct memory-protocol client under
    // specs#95, or a serving-runtime bug). Given such a write, the rule
    // honors the viewer the atom names with no further question, which is
    // the leak these cases show.

    const MOVE = verified("move");

    /** The two-part stamp the card-table rule matches, `viewer` and all. */
    const witnessed = (
      identity: ImplementationIdentity,
      witness: ImplementationIdentity,
      viewer?: string,
    ): CfcAtom =>
      ({
        type: CFC_ATOM_TYPE.TransformedBy,
        identity,
        inputWitness: { type: CFC_ATOM_TYPE.TransformedBy, identity: witness },
        ...(viewer === undefined ? {} : { viewer }),
      }) as CfcAtom;

    /** The card-table rule as the pattern ships it: viewFor + move + viewer. */
    const CARD_TABLE_RULES: CfcPolicyRecordInput[] = [{
      id: "table",
      rules: [{
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
            inputWitness: {
              type: CFC_ATOM_TYPE.TransformedBy,
              identity: {
                kind: "verified",
                moduleIdentity: "module:table",
                symbol: "move",
              },
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
      }],
    }];

    const withTable = (body: (runtime: Runtime) => Promise<void>) =>
      withRuntime(body, { rules: CARD_TABLE_RULES });

    it("releases to the viewer a forged stamp names", async () => {
      // LEAK. A forged `viewFor`+`move`+`viewer: EVE` stamp on a sealed
      // document releases the document to EVE, though no run ever computed
      // it for her: the atom is the whole evidence, and it was authored, not
      // earned.

      await withTable(async (runtime) => {
        await seedStamped(runtime, "forged", { hand: ["AS", "KH"] }, [
          witnessed(VIEW, MOVE, EVE),
        ]);
        await derive(runtime, ["forged"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([releasedTo(EVE)]);
      });
    });

    it("releases to a principal unrelated to the value or its location", async () => {
      // LEAK. The viewer need not be a seat, a reader, or anyone the value
      // mentions. Nothing ties `viewer` to the document's scope key, so a
      // space-scoped (shared) document stamped for EVE releases to EVE.

      await withTable(async (runtime) => {
        await seedStamped(runtime, "shared", { secret: "every hand" }, [
          witnessed(VIEW, MOVE, EVE),
        ]);
        await derive(runtime, ["shared"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([releasedTo(EVE)]);
      });
    });

    it("withholds a stamp carrying no move witness", async () => {
      // REFUSED. The rule's `inputWitness: move` conjunct bites: a
      // `viewFor`+`viewer` stamp with no move witness is not matched, so the
      // sealed clause stays. The conjunct is itself forgeable data, so it
      // raises the bar on a forger by one atom and no more.

      await withTable(async (runtime) => {
        await seedStamped(runtime, "unwitnessed", { hand: ["AS"] }, [
          transformedBy(VIEW, EVE),
        ]);
        await derive(runtime, ["unwitnessed"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      });
    });

    it("withholds a stamp whose code is not the released function", async () => {
      // REFUSED. The rule names `viewFor`. A stamp of other code (`peek`)
      // carrying a move witness and a viewer is not matched.

      await withTable(async (runtime) => {
        await seedStamped(runtime, "wrong-code", "every hand", [
          witnessed(OTHER, MOVE, EVE),
        ]);
        await derive(runtime, ["wrong-code"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      });
    });
  });

  describe("the viewer mint serves exactly one principal", () => {
    // ATTACK (threat-model probe #6). The mint names a viewer only when the
    // transaction recorded exactly one (`deriveFlowJoin`'s
    // `viewers.length === 1 ? viewers[0] : undefined`). These cases record
    // the viewers on the deriving transaction directly, as a run accruing a
    // second viewer would, and show one viewer releases and two viewers
    // release nothing: a run that stands for two demanders mints no atom and
    // widens no audience.

    /**
     * A computation under `VIEW` that reads a sealed input and writes a value
     * of it to `output`, having recorded `viewers` on its transaction under
     * the runtime's own authorization.
     */
    const deriveForViewers = async (
      runtime: Runtime,
      viewers: readonly string[],
      output: string,
    ): Promise<void> => {
      const tx = runtime.edit();
      setCfcImplementationIdentity(tx, VIEW);
      for (const viewer of viewers) {
        tx.recordCfcViewer(viewer, runtimeWritePolicyAuthorization);
      }
      const value = runtime.getCell(space, "sealed-in", undefined, tx).getRaw();
      tx.writeOrThrow({
        space,
        scope: "space",
        id: idOf(runtime, output, tx),
        path: ["value"],
      }, JSON.stringify(value));
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    it("releases what a one-viewer run wrote to that viewer", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "sealed-in", { hand: ["AS"] }, []);
        await deriveForViewers(runtime, [ALICE], "stamped");
        await derive(runtime, ["stamped"], "seen");
        expect(clausesOf(runtime, "seen")).toEqual([releasedTo(ALICE)]);
      });
    });

    it("releases nothing of what a two-viewer run wrote", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "sealed-in", { hand: ["AS"] }, []);
        await deriveForViewers(runtime, [ALICE, BOB], "stamped");
        await derive(runtime, ["stamped"], "seen");
        expect(clausesOf(runtime, "seen")).toEqual([SEALED]);
      });
    });
  });
});

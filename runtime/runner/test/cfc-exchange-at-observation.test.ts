import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";

import {
  SEED_ENVELOPE_SCHEMA,
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
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
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "../src/storage/cache.deno.ts";
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
  describe("a stored stamp and a rule that names an input witness", () => {
    // The rule releases a view `viewFor` wrote for a viewer out of what
    // `move` wrote, so the stamp it matches holds an `inputWitness` beside
    // its viewer. The cases directly in this group seed their stamps as the
    // groups above do, through the privileged write, which stands in for the
    // run that would have minted one. No run here did. The evaluator matches
    // the stored atom against the rule's pattern, and the atom names neither
    // the run that minted it nor the document that holds it.

    const MOVE = verified("move");

    /** The stamp `identity` leaves on what it wrote out of `witness`'s. */
    const witnessed = (
      identity: ImplementationIdentity,
      witness: ImplementationIdentity,
      viewer: string,
    ): CfcAtom =>
      ({
        type: CFC_ATOM_TYPE.TransformedBy,
        identity,
        inputWitness: { type: CFC_ATOM_TYPE.TransformedBy, identity: witness },
        viewer,
      }) as CfcAtom;

    const WITNESSED_RULES: CfcPolicyRecordInput[] = [{
      id: "table",
      rules: [{
        id: "release-own-view-of-a-move",
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

    it("carries the viewer the stamp names beside the sealed clause", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "view", { hand: ["AS", "KH"] }, [
          witnessed(VIEW, MOVE, EVE),
        ]);
        await derive(runtime, ["view"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([releasedTo(EVE)]);
      }, { rules: WITNESSED_RULES });
    });

    it("carries a viewer other than the principal whose user scope holds the document", async () => {
      // The document is the signer's own instance at the user scope, and the
      // stamp on it names another principal.

      await withRuntime(async (runtime) => {
        const seeding = runtime.edit();
        writeSeedEnvelopeDoc(seeding, space);
        seedStoredEnvelope(seeding, {
          space,
          scope: "user",
          id: idOf(runtime, "own-view", seeding),
          path: [],
        }, {
          value: { hand: ["AS"] },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                origin: "derived",
                observes: "value",
                label: {
                  confidentiality: [SEALED],
                  integrity: [witnessed(VIEW, MOVE, EVE)],
                },
              }],
            },
          },
        });
        expect((await seeding.commit().settled).ok).toBeDefined();

        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, DERIVE);
        const value = runtime
          .getCell(space, "own-view", undefined, tx, "user").getRaw();
        expect(value).toEqual({ hand: ["AS"] });
        expect(runtime.getCell(space, "own-view").getRaw()).toBeUndefined();
        tx.writeOrThrow({
          space,
          scope: "space",
          id: idOf(runtime, "derived", tx),
          path: ["value"],
        }, JSON.stringify(value));
        tx.prepareCfc();
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(clausesOf(runtime, "derived")).toEqual([releasedTo(EVE)]);
      }, { rules: WITNESSED_RULES });
    });

    it("keeps the sealed clause of a stamp holding no input witness", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "unwitnessed", { hand: ["AS"] }, [
          transformedBy(VIEW, EVE),
        ]);
        await derive(runtime, ["unwitnessed"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      }, { rules: WITNESSED_RULES });
    });

    it("keeps the sealed clause of a stamp whose witness names other code", async () => {
      await withRuntime(async (runtime) => {
        await seedStamped(runtime, "other-witness", { hand: ["AS"] }, [
          witnessed(VIEW, OTHER, EVE),
        ]);
        await derive(runtime, ["other-witness"], "derived");
        expect(clausesOf(runtime, "derived")).toEqual([SEALED]);
      }, { rules: WITNESSED_RULES });
    });

    describe("where a session sent the stamp to the store itself", () => {
      // TODO(jkomoros): This pins a release the runtime should not make. The
      // stamp is one "minted by the runtime for one attempt, from the
      // identity that ran and the witnesses it consumed, and by nothing
      // else" (§15.4, `15-atom-registry.md`), and here a memory protocol
      // session with no runtime behind it sets the document, label and all,
      // naming its own principal as the viewer.
      // The store keeps the label as sent, and a runtime that then reads the
      // document matches the stamp as it matches one a run minted. Flip it
      // when the store refuses or strips a stamp no runtime's label
      // derivation produced, or the evaluator asks for evidence of the mint.
      //
      // The server is the loopback one, which admits an unsigned open as the
      // principal it names and keeps no access list. So the case shows what
      // a session able to write the space can do, and nothing about which
      // sessions a deployment lets write it.

      it("carries the viewer the stamp names beside the sealed clause", async () => {
        const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const storageManager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager,
          cfcFlowLabels: "persist",
          cfcPolicyRecords: WITNESSED_RULES,
          cfcPolicyEvaluation: "enforce",
        });
        const client = await MemoryV2Client.connect({
          instanceNames: namesInstancesByDefault(),
          transport: MemoryV2Client.loopback(server),
        });
        try {
          const session = await client.mount(
            space,
            {},
            (_space, _session, context) => ({
              invocation: {
                aud: context.audience,
                challenge: context.challenge.value,
              },
              authorization: { principal: EVE },
            }),
          );
          await session.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `cid:${SEED_ENVELOPE_SCHEMA_HASH}`,
              value: { value: SEED_ENVELOPE_SCHEMA },
            }, {
              op: "set",
              id: runtime.getCell(space, "sent").getAsNormalizedFullLink().id,
              value: {
                value: { hand: ["AS", "KH"] },
                cfc: {
                  version: 1,
                  schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
                  labelMap: {
                    version: 1,
                    entries: [{
                      path: [],
                      origin: "derived",
                      observes: "value",
                      label: {
                        confidentiality: [SEALED],
                        integrity: [witnessed(VIEW, MOVE, EVE)],
                      },
                    }],
                  },
                },
              },
            }],
          });

          await runtime.getCell(space, "sent").sync();
          await derive(runtime, ["sent"], "derived");
          expect(clausesOf(runtime, "derived")).toEqual([releasedTo(EVE)]);
        } finally {
          await client.close();
          await runtime.dispose();
          await storageManager.close();
          await server.close();
        }
      });
    });
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  commitCustodySeal,
  CUSTODY_SEAL_READER,
  type CustodyRoom,
  prepareCustodySeal,
  publishCustodyAnswer,
  readCustodyAnswer,
  TRUSTED_DECLASSIFIER_CONCEPT,
} from "../src/cfc/custody-seal.ts";
import { ACLManager } from "../src/acl-manager.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import type { CfcTrustConfigInput } from "../src/cfc/trust.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import { hostGestureProvenance } from "../src/cfc/host-review.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

// A custody room releases one answer per instance. Its projector is
// reactive: pointed at other input, or run again, it computes again, and a
// room rendering it would show each result its rule releases. The seal
// publishes the answer once into a create-only slot the room renders, so the
// answer published for an instance never changes after the first publication.
// Which instance a room renders is its bindings' to say, which the room's
// members can write; the custody seal spec says what that leaves open.

const alice = await Identity.fromPassphrase("custody-answer-alice");
const bob = await Identity.fromPassphrase("custody-answer-bob");
const mallory = await Identity.fromPassphrase("custody-answer-mallory");
const roomOwner = await Identity.fromPassphrase("custody-answer-room");
const S = roomOwner.did();

const MODULE = "sha256:custody-answer-module";
const REVIEWER = "did:web:review.example";

const SEALED_BY = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: { kind: "builtin", builtinId: "cfc-custody-seal" },
};

const PROJECT: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: MODULE,
  symbol: "projectChoice",
  bindingPath: ["projectChoice"],
};

/** The room's policy: it releases what `projectChoice` computed, `witnessed`
 * requiring as well that everything it read was the seal's, and `toSeal`
 * releasing it to the seal alone rather than to the room's readers. */
const policyArtifact = (witnessed: boolean, toSeal: boolean) =>
  buildCfcPolicyArtifactManifest({
    formatVersion: 1,
    moduleIdentity: MODULE,
    symbol: "custodyRules",
    template: {
      templateVersion: 1,
      exchangeRules: [{
        name: "releaseChoice",
        preCondition: {
          confidentiality: [{ thisPolicy: true }],
          integrity: [{
            type: CFC_ATOM_TYPE.TransformedBy,
            identity: {
              kind: "verified",
              moduleIdentity: { thisPolicyField: "moduleIdentity" },
              symbol: "projectChoice",
            },
            ...(witnessed ? { inputWitness: SEALED_BY } : {}),
          }],
        },
        postCondition: {
          confidentiality: toSeal ? [CUSTODY_SEAL_READER] : [],
          integrity: [],
        },
      }],
      dependencies: { authorityOnly: [], dataBearing: [] },
      integrityRequirements: {},
    },
  } as never);

/** A member's own policy, whose rule releases whatever the member's code
 * computed: nothing a room would install, but every policy a label names is
 * evaluated. */
const OTHER_MODULE = "sha256:custody-answer-other-module";
const otherArtifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: OTHER_MODULE,
  symbol: "releaseAnything",
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "releaseAnything",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: { kind: "verified", moduleIdentity: "sha256:member-code" },
        }],
      },
      postCondition: { confidentiality: [], integrity: [] },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
} as never);

const STANCE_SCHEMA = {
  type: "object",
  properties: { choice: { enum: ["pizza", "sushi", "tacos"] } },
  required: ["choice"],
  additionalProperties: false,
};

const termsFor = (question: string) => ({
  question,
  seats: [alice.did(), bob.did()],
  stanceSchema: STANCE_SCHEMA,
});

const trustedClick = () => {
  const event = {
    type: "click",
    provenance: hostGestureProvenance("CustodySeal"),
  };
  markRendererTrustedEvent(event);
  return event;
};

type Fixture = Awaited<ReturnType<typeof setup>>;

/** Three members' runtimes over one server, and a room whose policy is
 * installed in its space. */
const setup = async ({ witnessed = true, toSeal = true } = {}) => {
  const artifact = policyArtifact(witnessed, toSeal);
  const policy = cfcAtom.modulePolicyRef(
    MODULE,
    "custodyRules",
    artifact.policyDigest,
    S,
  );
  const trust: CfcTrustConfigInput = {
    statements: [{
      concrete: {
        type: CFC_ATOM_TYPE.Policy,
        policyRefKind: "module",
        moduleIdentity: MODULE,
        symbol: "custodyRules",
        policyDigest: artifact.policyDigest,
      },
      implements: TRUSTED_DECLASSIFIER_CONCEPT,
      verifier: REVIEWER,
    }],
    delegations: [{
      delegator: "*",
      verifier: REVIEWER,
      concepts: [TRUSTED_DECLASSIFIER_CONCEPT],
    }],
  };
  const server: MemoryV2Server.Server = newSharedServer({
    subscriptionRefreshDelayMs: 0,
  });
  const managers: EmulatedStorageManager[] = [];
  const created: Runtime[] = [];
  const runtimeFor = (identity: Identity): Runtime => {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: identity,
    });
    managers.push(storageManager);
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      trustSnapshotProvider: () => ({
        id: identity.did(),
        actingPrincipal: identity.did(),
      }),
      cfcTrustConfig: trust,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    runtime.registerCfcPolicyManifests(undefined, [artifact, otherArtifact]);
    created.push(runtime);
    return runtime;
  };
  const runtimes = new Map<Identity, Runtime>(
    [alice, bob, mallory].map((identity) => [identity, runtimeFor(identity)]),
  );
  const host = runtimes.get(alice)!;
  const install = host.edit();
  host.getCell(S, "custody-room-state", {
    type: "object",
    ifc: {
      confidentiality: [{ ...policy, subject: { __ctOwningSpace: true } }],
    },
  } as never, install).set({ open: true } as never);
  const terms = host.getCell(S, "custody-terms", undefined, install);
  terms.set(termsFor("Where should we eat?") as never);
  // The room document whose cells receive the seal's links.
  host.getCell(S, "room-cells", undefined, install).set({} as never);
  expect((await install.commit().settled).error).toBeUndefined();
  const roomAcl = new ACLManager(runtimeFor(roomOwner), S);
  await roomAcl.set(alice.did(), "OWNER");
  for (const member of [bob, mallory]) {
    await roomAcl.set(member.did(), "WRITE");
  }

  const syncManifest = async (runtime: Runtime) => {
    for (const digest of [artifact.policyDigest, otherArtifact.policyDigest]) {
      await runtime.getCellFromEntityId(S, cfcPolicyManifestDocId(digest))
        .sync();
    }
  };

  const fixture = {
    runtimes,
    policy,
    terms: terms.withTx(undefined),
    room(identity: Identity, box?: Cell<unknown>): CustodyRoom {
      const runtime = runtimes.get(identity)!;
      return {
        terms: runtime.getCellFromLink(terms.getAsNormalizedFullLink()),
        policy,
        ...(box === undefined
          ? {}
          : { box: runtime.getCellFromLink(box.getAsNormalizedFullLink()) }),
      };
    },
    /** Replaces the room's terms, which starts a fresh instance. */
    async setTerms(question: string): Promise<void> {
      const tx = host.edit();
      host.getCellFromLink(terms.getAsNormalizedFullLink(), undefined, tx)
        .set(termsFor(question) as never);
      expect((await tx.commit().settled).error).toBeUndefined();
    },
    /** Seals `choice` for `identity`, linking the box into `box`. */
    async seal(identity: Identity, choice: string, box: Cell<unknown>) {
      const runtime = runtimes.get(identity)!;
      const home = identity.did();
      const tx = runtime.edit();
      const draft = runtime.getCell(home, `stance-${choice}`, undefined, tx);
      writeSeedEnvelopeDoc(tx, home);
      seedStoredEnvelope(tx, {
        space: home,
        scope: "space",
        id: draft.getAsNormalizedFullLink().id,
        path: [],
      }, {
        value: { choice },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: [cfcAtom.user(home)] },
            }],
          },
        },
      } as FabricValue);
      expect((await tx.commit().settled).error).toBeUndefined();
      const prepared = await prepareCustodySeal(
        draft.withTx(undefined),
        fixture.room(identity, box),
        { allowedSources: [] },
      );
      return await commitCustodySeal(prepared.consent, trustedClick());
    },
    /**
     * One run of the room's projector: the first choice every entry it finds
     * through `from` agrees on, written as a string into `output`.
     */
    async project(
      identity: Identity,
      from: Cell<unknown>,
      output: Cell<unknown>,
      clause: unknown = { ...policy, subject: { __ctOwningSpace: true } },
      code: ImplementationIdentity = PROJECT,
    ): Promise<string | { refused: string }> {
      const runtime = runtimes.get(identity)!;
      await syncManifest(runtime);
      const local = runtime.getCellFromLink(from.getAsNormalizedFullLink());
      await local.sync();
      await local.pull();
      const target = runtime.getCellFromLink(
        output.getAsNormalizedFullLink(),
        {
          type: "string",
          ifc: { confidentiality: [clause] },
        } as never,
      );
      await target.sync();
      let answer = "";
      const written = await runtime.editWithRetry((tx) => {
        setCfcImplementationIdentity(tx, code);
        const entries = (local.withTx(tx).get() ?? {}) as Record<
          string,
          { stance?: { choice?: string } }
        >;
        const choices = Object.values(entries).map((entry) =>
          entry?.stance?.choice ?? ""
        );
        answer = choices.every((choice) => choice === choices[0])
          ? choices[0] ?? ""
          : "no agreement";
        target.withTx(tx).set(answer as never);
      });
      if (written.error !== undefined) {
        return { refused: String(written.error.message) };
      }
      return answer;
    },
    async publish(identity: Identity, output: Cell<unknown>) {
      const runtime = runtimes.get(identity)!;
      await syncManifest(runtime);
      return await publishCustodyAnswer(
        fixture.room(identity),
        runtime.getCellFromLink(output.getAsNormalizedFullLink()),
      );
    },
    /** The instance's published answer, as `identity`'s host reads it. */
    async shown(identity: Identity) {
      const runtime = runtimes.get(identity)!;
      await syncManifest(runtime);
      return await readCustodyAnswer(fixture.room(identity));
    },
    async dispose() {
      for (const runtime of created) {
        await runtime.dispose({ closeStorage: false });
      }
      for (const manager of managers) await manager.close();
      await server.close();
    },
  };
  return fixture;
};

/** Writes `value` into `cell` as a member's own code. */
const writeAsMember = async (
  fixture: Fixture,
  cell: Cell<unknown>,
  value: (runtime: Runtime, tx: IExtendedStorageTransaction) => unknown,
  schema: unknown = { type: "object" },
) => {
  const runtime = fixture.runtimes.get(mallory)!;
  const local = runtime.getCellFromLink(
    cell.getAsNormalizedFullLink(),
    schema as never,
  );
  await local.sync();
  const written = await runtime.editWithRetry((tx) => {
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: "sha256:member-code",
      symbol: "repoint",
      bindingPath: ["repoint"],
    });
    local.withTx(tx).set(value(runtime, tx) as never);
  });
  expect(written.error).toBeUndefined();
};

/** {@link writeAsMember}, answering the refusal's message if refused. */
const attemptAsMember = async (
  fixture: Fixture,
  cell: Cell<unknown>,
  write: (local: Cell<unknown>, runtime: Runtime) => void,
): Promise<string | undefined> => {
  const runtime = fixture.runtimes.get(mallory)!;
  // Through the member's own handle: no schema, so nothing the seal's
  // handle declares comes with it.
  const local = runtime.getCellFromLink({
    ...cell.getAsNormalizedFullLink(),
    schema: undefined,
  });
  await local.sync();
  const written = await runtime.editWithRetry((tx) => {
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: "sha256:member-code",
      symbol: "rewrite",
      bindingPath: ["rewrite"],
    });
    write(local.withTx(tx), runtime);
  });
  return written.error === undefined
    ? undefined
    : String(written.error.message);
};

describe("custody answers", () => {
  const boxOf = (fixture: Fixture) =>
    fixture.runtimes.get(alice)!.getCell(S, "room-cells").key("box");
  const outputOf = (fixture: Fixture) =>
    fixture.runtimes.get(alice)!.getCell(S, "custody-room-choice");

  it("publishes the first honest answer, and later runs change nothing shown", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      const { box: realBox, entryKey } = await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect(await fixture.shown(mallory)).toBeUndefined();
      const { value } = await fixture.publish(bob, output);
      expect(value).toBe("sushi");
      expect(await fixture.shown(mallory)).toBe("sushi");

      // A member's code points the box at a record repeating Alice's entry
      // beside one it made up, and the projector runs again.
      const record = fixture.runtimes.get(mallory)!.getCell(S, "crafted");
      await writeAsMember(fixture, record, (runtime, tx) => ({
        real: runtime.getCellFromLink(
          { ...realBox.getAsNormalizedFullLink(), path: [entryKey] },
          undefined,
          tx,
        ),
        madeUp: { stance: { choice: "tacos" } },
      }), { type: "object", ifc: { confidentiality: [cfcAtom.space(S)] } });
      expect(await fixture.project(bob, record, output)).toBe("no agreement");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "already published",
      );
      // And again over the honest box: the answer is what it was.
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      await expect(fixture.publish(alice, output)).rejects.toThrow(
        "already published",
      );
      expect(await fixture.shown(mallory)).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer the policy does not release", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      const { box: realBox, entryKey } = await fixture.seal(bob, "sushi", box);
      // The projector reads a record repeating Bob's entry: no witness.
      const record = fixture.runtimes.get(mallory)!.getCell(S, "repeated");
      await writeAsMember(fixture, record, (runtime, tx) => {
        const entry = runtime.getCellFromLink(
          { ...realBox.getAsNormalizedFullLink(), path: [entryKey] },
          undefined,
          tx,
        );
        return { first: entry, second: entry };
      }, { type: "object", ifc: { confidentiality: [cfcAtom.space(S)] } });
      expect(await fixture.project(bob, record, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "releases to the seal",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a value that never carried the room's policy", async () => {
    // A member's code names a cell of its own, labeled for the room's
    // readers, as the answer: its label admits the room, but no rule of the
    // policy released it.
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      const forged = fixture.runtimes.get(mallory)!.getCell(S, "forged");
      await writeAsMember(
        fixture,
        forged,
        () => "tacos",
        { type: "string", ifc: { confidentiality: [cfcAtom.space(S)] } },
      );
      await expect(fixture.publish(mallory, forged)).rejects.toThrow(
        "releases to the seal",
      );
      const output = outputOf(fixture);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect((await fixture.publish(bob, output)).value).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a value whose policy and witness a member's schema declared", async () => {
    // A member's code writes a made-up answer into a cell whose schema
    // declares the room's policy and the witnessed projector's integrity.
    // Declared integrity is not a derivation: the value has no witness.
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      await fixture.seal(alice, "sushi", box);
      const { instance } = await fixture.seal(bob, "sushi", box);
      const forged = fixture.runtimes.get(mallory)!.getCell(S, "declared");
      await writeAsMember(fixture, forged, () => "tacos", {
        type: "string",
        ifc: {
          confidentiality: [{
            ...fixture.policy,
            subject: { __ctOwningSpace: true },
          }],
          integrity: [{
            type: CFC_ATOM_TYPE.TransformedBy,
            identity: {
              kind: "verified",
              moduleIdentity: MODULE,
              symbol: "projectChoice",
              bindingPath: ["projectChoice"],
            },
            inputWitness: {
              type: CFC_ATOM_TYPE.TransformedBy,
              identity: {
                kind: "builtin",
                builtinId: "cfc-custody-seal",
                instance,
              },
            },
          }],
        },
      });
      await expect(fixture.publish(mallory, forged)).rejects.toThrow(
        "releases to the seal",
      );
      const output = outputOf(fixture);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect((await fixture.publish(bob, output)).value).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("cannot label an answer for another policy's rule to release", async () => {
    // A member's own code reads the sealed box (so what it computes carries
    // the seal's witness) and labels its result with a clause naming the
    // room's policy OR one of its own whose rule releases anything, so that
    // rule, not the room's, would drop the room's clause. Writer fit refuses
    // the write: the box's entries carry the room's policy, and a clause
    // that also admits another policy is weaker than it.
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      const other = cfcAtom.modulePolicyRef(
        OTHER_MODULE,
        "releaseAnything",
        otherArtifact.policyDigest,
        S,
      );
      const result = await fixture.project(bob, box, output, {
        anyOf: [
          { ...fixture.policy, subject: { __ctOwningSpace: true } },
          { ...other, subject: { __ctOwningSpace: true } },
        ],
      }, {
        kind: "verified",
        moduleIdentity: "sha256:member-code",
        symbol: "projectChoice",
        bindingPath: ["projectChoice"],
      });
      expect(result).toEqual({
        refused: expect.stringContaining("writer-fit confidentiality misfit"),
      });
      // The honest projector still publishes over the same box.
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect((await fixture.publish(bob, output)).value).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer slot other code wrote first, and shows nothing from it", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      const { instance } = await fixture.seal(bob, "sushi", box);
      // The slot's address derives from the policy and the instance, which
      // any room reader can compute.
      await writeAsMember(
        fixture,
        fixture.runtimes.get(mallory)!.getCell(S, {
          custodyAnswer: { policy: fixture.policy, instance },
        }),
        () => ({ instance, answer: "tacos" }),
      );
      await expect(fixture.shown(bob)).rejects.toThrow(
        "slot the seal did not write",
      );
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "slot the seal did not write",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps a published answer as the seal wrote it, whatever a member writes beneath it", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      const { instance, answer: slot } = await fixture.publish(bob, output);
      expect(await fixture.shown(mallory)).toBe("sushi");
      const writes: [string, (local: Cell<unknown>) => void][] = [
        ["the answer", (local) => local.key("answer").set("tacos")],
        ["the instance", (local) => local.key("instance").set("other")],
        ["a key beside them", (local) => local.key("extra").set("tacos")],
        [
          "an object in place of the answer",
          (local) => local.key("answer").set({ choice: "tacos" } as never),
        ],
        // A claim whose schema names a type governs writes of that type.
        [
          "a string in place of the slot",
          (local) => local.set("tacos" as never),
        ],
        [
          "a list in place of the slot",
          (local) => local.set(["tacos"] as never),
        ],
        [
          "another slot in place of this one",
          (local) => local.set({ instance, answer: "tacos" } as never),
        ],
      ];
      // The slot's claim is stored with it, so every write is refused, the
      // primitive over its root included, and the slot still shows what the
      // seal wrote.
      for (const [what, write] of writes) {
        const refused = await attemptAsMember(fixture, slot, write);
        expect({ what, refused }).toEqual({
          what,
          refused: expect.stringContaining("writeAuthorizedBy"),
        });
        expect({ what, shown: await fixture.shown(mallory) }).toEqual({
          what,
          shown: "sushi",
        });
      }
      // And through a write redirect a member's own cell holds.
      const redirect = fixture.runtimes.get(mallory)!.getCell(S, "to-answer");
      await writeAsMember(
        fixture,
        redirect,
        (runtime, tx) =>
          runtime.getCellFromLink(
            { ...slot.getAsNormalizedFullLink(), path: ["answer"] },
            undefined,
            tx,
          ).getAsWriteRedirectLink(),
      );
      const throughRedirect = await attemptAsMember(
        fixture,
        redirect,
        (local) => local.set("tacos" as never),
      );
      expect(throughRedirect).toEqual(
        expect.stringContaining("writeAuthorizedBy"),
      );
      expect(await fixture.shown(mallory)).toBe("sushi");
      expect(instance).toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses quietly while the projector has computed nothing", async () => {
    // Every seat has sealed but the projector has not run yet: its output
    // holds nothing, which is not yet an answer, and is refused the way an
    // answer the policy does not release is.
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      const output = outputOf(fixture);
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "releases to the seal",
      );
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect((await fixture.publish(bob, output)).value).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer before every seat has sealed", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      expect(await fixture.project(alice, box, output)).toBe("sushi");
      await expect(fixture.publish(alice, output)).rejects.toThrow(
        "every seat to have sealed",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a policy that releases anything without the seal's witness", async () => {
    const fixture = await setup({ witnessed: false });
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "requires the seal's witness",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a policy whose rule releases the projection to the room's readers", async () => {
    // Readable by the room's readers, a projection that a member's code
    // points at input of its own keeps its earlier witnessed stamp while its
    // answer does not change, and says whether that input yields the
    // released answer. Only a policy releasing to the seal is published.
    const fixture = await setup({ toSeal: false });
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "releases only to the seal",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer computed over an earlier instance's box", async () => {
    // An earlier instance may have had other members; its answer is not this
    // instance's to release.
    const fixture = await setup();
    try {
      const first = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", first);
      await fixture.seal(bob, "sushi", first);

      await fixture.setTerms("Where should we eat tomorrow?");
      const second = fixture.runtimes.get(alice)!.getCell(S, "room-cells").key(
        "second",
      );
      await fixture.seal(alice, "tacos", second);
      await fixture.seal(bob, "tacos", second);
      // The projector reads the earlier instance's genuine box.
      expect(await fixture.project(bob, first, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "releases to the seal",
      );
      expect(await fixture.project(bob, second, output)).toBe("tacos");
      expect((await fixture.publish(bob, output)).value).toBe("tacos");
    } finally {
      await fixture.dispose();
    }
  });

  it("publishes again for a fresh instance", async () => {
    const fixture = await setup();
    try {
      const first = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", first);
      await fixture.seal(bob, "sushi", first);
      expect(await fixture.project(bob, first, output)).toBe("sushi");
      const earlier = await fixture.publish(bob, output);

      await fixture.setTerms("Where should we eat tomorrow?");
      // A seal for this instance does not write into the earlier instance's
      // custody documents, its answer slot or its anchor.
      for (const kind of ["custodyAnswer", "custodyAnchor"] as const) {
        const earlierDoc = fixture.runtimes.get(alice)!.getCell(S, {
          [kind]: { policy: fixture.policy, instance: earlier.instance },
        });
        await expect(fixture.seal(alice, "tacos", earlierDoc.key("x")))
          .rejects.toThrow("only from a cell that holds nothing else");
      }
      const second = fixture.runtimes.get(alice)!.getCell(S, "room-cells").key(
        "second",
      );
      await fixture.seal(alice, "tacos", second);
      await fixture.seal(bob, "tacos", second);
      expect(await fixture.project(bob, second, output)).toBe("tacos");
      const later = await fixture.publish(bob, output);
      expect(later.instance).not.toBe(earlier.instance);
      expect(await fixture.shown(mallory)).toBe("tacos");
      expect(later.answer.getAsNormalizedFullLink().id).not.toBe(
        earlier.answer.getAsNormalizedFullLink().id,
      );
    } finally {
      await fixture.dispose();
    }
  });
});

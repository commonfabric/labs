import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { utf8Compare } from "@commonfabric/utils/utf8";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  commitCustodySeal,
  type CustodyRoom,
  type CustodySealConsent,
  type CustodySealOptions,
  prepareCustodySeal as prepareWithOptions,
  readCustodySourcePolicy,
  TRUSTED_DECLASSIFIER_CONCEPT,
} from "../src/cfc/custody-seal.ts";
import { ACLManager } from "../src/acl-manager.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import type { CfcTrustConfigInput } from "../src/cfc/trust.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { isAllowedAuthoredImportSpecifier } from "../src/sandbox/runtime-module-policy.ts";
import { getRuntimeModuleExports } from "../src/sandbox/runtime-modules.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const alice = await Identity.fromPassphrase("custody-seal-alice");
const bob = await Identity.fromPassphrase("custody-seal-bob");
const carol = await Identity.fromPassphrase("custody-seal-carol");
const mallory = await Identity.fromPassphrase("custody-seal-mallory");
const roomOwner = await Identity.fromPassphrase("custody-seal-room");
const S = roomOwner.did();

const MODULE = "sha256:custody-module";
const REVIEWER = "did:web:review.example";

const artifactFor = (symbol: string) =>
  buildCfcPolicyArtifactManifest({
    formatVersion: 1,
    moduleIdentity: MODULE,
    symbol,
    template: {
      templateVersion: 1,
      exchangeRules: [],
      dependencies: { authorityOnly: [], dataBearing: [] },
      integrityRequirements: {},
    },
  });

const CUSTODY = artifactFor("custodyRules");
const SCRATCH = artifactFor("scratchRules");

const policyOf = (artifact = CUSTODY, subject = S) =>
  cfcAtom.modulePolicyRef(
    MODULE,
    artifact.manifest.symbol,
    artifact.policyDigest,
    subject,
  );

const P = policyOf();

/** The actor's standing trust: the custody symbol is a trusted declassifier. */
const TRUST: CfcTrustConfigInput = {
  statements: [{
    concrete: {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: MODULE,
      symbol: "custodyRules",
      policyDigest: CUSTODY.policyDigest,
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

const STANCE_SCHEMA = {
  type: "object",
  properties: {
    choice: { enum: ["pizza", "sushi", "tacos"] },
    budget: { type: "integer", minimum: 0, maximum: 500 },
    flexible: { type: "boolean" },
    prefs: {
      type: "object",
      properties: {
        spice: {
          type: "object",
          properties: { level: { enum: [0, 1, 2] } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  required: ["choice", "budget"],
  additionalProperties: false,
};

const TERMS = {
  question: "Where should we eat?",
  seats: [alice.did(), bob.did(), carol.did()],
  stanceSchema: STANCE_SCHEMA,
};

const SEAL_IDENTITY = { kind: "builtin", builtinId: "cfc-custody-seal" };

/** Prepares with no sources allowed beyond the actor's own `User` clauses. */
const prepareCustodySeal = (
  draft: Cell<unknown>,
  room: CustodyRoom,
  options: CustodySealOptions = { allowedSources: [] },
) => prepareWithOptions(draft, room, options);

const PROJECT: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: MODULE,
  symbol: "projectBallot",
  bindingPath: ["projectBallot"],
};

/** Creates the renderer-side mark attached only by the trusted host. */
const trustedClick = (pattern = "CustodySeal") => {
  const event = {
    type: "click",
    provenance: { origin: "dom", trusted: true, ui: { pattern } },
  };
  markRendererTrustedEvent(event);
  return event;
};

const owner = (identity: Identity) => identity.did();

const context = (subject: string, name = "calendar") => ({
  type: CFC_ATOM_TYPE.Context,
  name,
  subject,
});

const resource = (subject: string, className = "finance") => ({
  type: CFC_ATOM_TYPE.Resource,
  class: className,
  subject,
});

type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * Four members' runtimes over one memory server, each signing as its own
 * identity, a room space holding public terms, and the room's custody policy
 * installed there.
 */
const setup = async (
  options: {
    trust?: CfcTrustConfigInput | undefined;
    terms?: unknown;
    acl?: boolean;
  } = {},
) => {
  const trust = "trust" in options ? options.trust : TRUST;
  const server: MemoryV2Server.Server = newSharedServer({
    subscriptionRefreshDelayMs: 0,
  });
  const managers: EmulatedStorageManager[] = [];
  const created: Runtime[] = [];
  const runtimeFor = (
    identity: Identity,
    signer: Identity = identity,
  ): Runtime => {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    managers.push(storageManager);
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      trustSnapshotProvider: () => ({
        id: identity.did(),
        actingPrincipal: identity.did(),
      }),
      ...(trust === undefined ? {} : { cfcTrustConfig: trust }),
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    // Every runtime is torn down, including one a test swaps into `runtimes`.
    created.push(runtime);
    return runtime;
  };
  const runtimes = new Map<Identity, Runtime>(
    [alice, bob, carol, mallory].map((identity) => [
      identity,
      runtimeFor(identity),
    ]),
  );
  for (const runtime of runtimes.values()) {
    runtime.registerCfcPolicyManifests(undefined, [CUSTODY]);
  }
  const host = runtimes.get(alice)!;
  const install = host.edit();
  // A room document declaring the policy installs its manifest in the room.
  host.getCell(S, "custody-room-state", {
    type: "object",
    ifc: { confidentiality: [{ ...P, subject: { __ctOwningSpace: true } }] },
  } as never, install).set({ open: true } as never);
  const terms = host.getCell(S, "custody-terms", undefined, install);
  terms.set((options.terms ?? TERMS) as never);
  expect((await install.commit()).error).toBeUndefined();
  // The room space's access list: its identity owns it, and the members read
  // and write it.
  const roomAcl = new ACLManager(runtimeFor(roomOwner), S);
  if (options.acl !== false) {
    // Carol owns the room's list; the room's own key is not on it.
    await roomAcl.set(carol.did(), "OWNER");
    for (const member of [alice, bob, mallory]) {
      await roomAcl.set(member.did(), "WRITE");
    }
  }

  const fixture = {
    runtimes,
    runtimeFor,
    roomAcl,
    terms: terms.withTx(undefined),
    room(identity: Identity, policy = P): CustodyRoom {
      const runtime = runtimes.get(identity)!;
      return {
        terms: runtime.getCellFromLink(terms.getAsNormalizedFullLink()),
        policy,
      };
    },
    /** Writes a draft into the actor's home space under a stored label. */
    async draft(
      identity: Identity,
      value: FabricValue,
      confidentiality: readonly unknown[] = [cfcAtom.user(identity.did())],
      cause = "stance-draft",
    ): Promise<Cell<unknown>> {
      const runtime = runtimes.get(identity)!;
      const home = identity.did();
      const tx = runtime.edit();
      const cell = runtime.getCell(home, cause, undefined, tx);
      writeSeedEnvelopeDoc(tx, home);
      seedStoredEnvelope(tx, {
        space: home,
        scope: "space",
        id: cell.getAsNormalizedFullLink().id,
        path: [],
      }, {
        value,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality } }],
          },
        },
      } as FabricValue);
      expect((await tx.commit()).error).toBeUndefined();
      return cell.withTx(undefined);
    },
    /** Prepares and commits one seal with a trusted click. */
    async seal(identity: Identity, value: FabricValue = honestStance) {
      const draft = await fixture.draft(identity, value);
      const prepared = await prepareCustodySeal(draft, fixture.room(identity));
      return await commitCustodySeal(prepared.consent, trustedClick());
    },
    async dispose() {
      // The managers are closed once, below, rather than by each runtime.
      for (const runtime of created) {
        await runtime.dispose({ closeStorage: false });
      }
      for (const manager of managers) await manager.close();
      await server.close();
    },
  };
  return fixture;
};

const honestStance = {
  choice: "sushi",
  budget: 40,
  prefs: { spice: { level: 1 } },
};

/**
 * Loads the room's installed policy manifest into `runtime`'s replica, as a
 * member's runtime holds it once it has opened the room.
 */
const syncManifest = async (runtime: Runtime) => {
  await runtime.getCellFromEntityId(
    S,
    cfcPolicyManifestDocId(CUSTODY.policyDigest),
  ).sync();
  const tx = runtime.edit();
  expect(runtime.resolveCfcPolicyManifest(P, tx, S, false)).toBeDefined();
  tx.abort();
};

const storedEntries = (runtime: Runtime, cell: Cell<unknown>) => {
  const tx = runtime.edit();
  const metadata = readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink());
  tx.abort();
  return metadata?.labelMap.entries ?? [];
};

const sealedBy = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: SEAL_IDENTITY,
};

/**
 * One run of the room's projector on `identity`'s runtime: it reads the whole
 * box, and each of `extra`, and writes a count into a policy-labeled output.
 */
const project = async (
  fixture: Fixture,
  identity: Identity,
  box: Cell<unknown>,
  extra: readonly Cell<unknown>[] = [],
): Promise<unknown[]> => {
  const runtime = fixture.runtimes.get(identity)!;
  await syncManifest(runtime);
  const local = runtime.getCellFromLink(box.getAsNormalizedFullLink());
  await local.sync();
  for (const cell of extra) {
    await runtime.getCellFromLink(cell.getAsNormalizedFullLink()).sync();
  }
  const tx = runtime.edit();
  tx.setCfcImplementationIdentity(PROJECT);
  const entries = local.withTx(tx).getRaw() as Record<string, unknown>;
  for (const cell of extra) {
    runtime.getCellFromLink(cell.getAsNormalizedFullLink()).withTx(tx)
      .getRaw();
  }
  const output = runtime.getCell(S, "ballot", {
    type: "object",
    ifc: {
      confidentiality: [{ ...P, subject: { __ctOwningSpace: true } }],
    },
  } as never, tx);
  output.set({ count: Object.keys(entries).length } as never);
  expect((await tx.commit()).error).toBeUndefined();
  return storedEntries(runtime, output).flatMap((entry) =>
    entry.label.integrity ?? []
  );
};

const witnessed = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: PROJECT,
  inputWitness: sealedBy,
};

describe("cfc-custody-seal", () => {
  describe("the box", () => {
    it("attributes every stored location of the box to the seal", async () => {
      const fixture = await setup();
      try {
        const { box } = await fixture.seal(alice);
        await fixture.seal(bob);
        const reader = fixture.runtimes.get(carol)!;
        const local = reader.getCellFromLink(box.getAsNormalizedFullLink());
        await local.sync();
        const valueEntries = storedEntries(reader, local).filter((entry) =>
          entry.origin === "derived" && entry.observes === "value"
        );
        const paths = valueEntries.map((entry) => entry.path.join("/"));
        expect(paths).toContain("");
        expect(valueEntries.length).toBeGreaterThan(2);
        for (const entry of valueEntries) {
          expect(entry.label.integrity).toContainEqual(sealedBy);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("mints the witnessed `TransformedBy` for a projector that reads the full box", async () => {
      const fixture = await setup();
      try {
        const { box } = await fixture.seal(alice);
        await fixture.seal(bob);
        await fixture.seal(carol);
        const integrity = await project(fixture, carol, box);
        expect(integrity).toContainEqual(witnessed);
      } finally {
        await fixture.dispose();
      }
    });

    it("mints no witness when the projector also reads one value the seal did not write", async () => {
      const fixture = await setup();
      try {
        const { box } = await fixture.seal(alice);
        await fixture.seal(bob);
        // The attacker's code runs in a member's runtime that has opened the
        // room; what matters is its identity, not whose runtime it is.
        const runtime = fixture.runtimes.get(alice)!;
        const tx = runtime.edit();
        tx.setCfcImplementationIdentity({
          kind: "verified",
          moduleIdentity: "sha256:attacker",
          symbol: "bitOfNote",
          bindingPath: ["bitOfNote"],
        });
        const crafted = runtime.getCell(S, "crafted-stance", {
          type: "object",
          ifc: { confidentiality: [cfcAtom.space(S)] },
        } as never, tx);
        crafted.set({ choice: "pizza", budget: 1 } as never);
        expect((await tx.commit()).error).toBeUndefined();

        const integrity = await project(fixture, carol, box, [crafted]);
        expect(integrity).toContainEqual({
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: PROJECT,
        });
        expect(integrity).not.toContainEqual(witnessed);
      } finally {
        await fixture.dispose();
      }
    });

    it("stores an entry whose key, value, and label do not name the actor", async () => {
      const fixture = await setup();
      try {
        const { box, entryKey } = await fixture.seal(alice);
        const reader = fixture.runtimes.get(bob)!;
        const local = reader.getCellFromLink(box.getAsNormalizedFullLink());
        await local.sync();
        // The terms list every seat, so the value names each member; what
        // it must not do is say which seat wrote this entry.
        expect(entryKey).not.toContain(alice.did());
        expect(JSON.stringify(storedEntries(reader, local))).not.toContain(
          alice.did(),
        );
        expect(local.getRaw()).toEqual({
          [entryKey]: {
            instance: expect.any(String),
            terms: expect.stringContaining("Where should we eat?"),
            stance: honestStance,
          },
        });
      } finally {
        await fixture.dispose();
      }
    });

    it("keys the same actor identically on a second device, and different actors differently", async () => {
      const fixture = await setup();
      try {
        const first = await fixture.seal(alice);
        const second = await fixture.seal(bob);
        expect(second.entryKey).not.toBe(first.entryKey);
        const device = fixture.runtimeFor(alice);
        fixture.runtimes.set(alice, device);
        device.registerCfcPolicyManifests(undefined, [CUSTODY]);
        const draft = await fixture.draft(alice, {
          choice: "tacos",
          budget: 9,
        });
        await expect(prepareCustodySeal(draft, fixture.room(alice)))
          .rejects.toThrow(/second entry for this actor/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses every write into the box by other code, at every depth and of every shape", async () => {
      // A stored writer claim governs writes at its own path, and a typed
      // claim only values of its type, so each case below writes somewhere or
      // something a claim on the root alone would not reach.
      const fixture = await setup();
      try {
        const { box, entryKey } = await fixture.seal(alice);
        const runtime = fixture.runtimes.get(bob)!;
        const local = runtime.getCellFromLink(box.getAsNormalizedFullLink());
        await local.sync();
        await syncManifest(runtime);
        const before = local.getRaw();
        const writes: [string, (cell: Cell<unknown>) => void][] = [
          ["the root", (cell) => cell.set({})],
          ["an entry", (cell) => cell.key(entryKey).set({ stance: {} })],
          ["an entry, as a string", (cell) => cell.key(entryKey).set("gone")],
          [
            "a stance field",
            (cell) => cell.key(entryKey).key("stance").key("budget").set(1),
          ],
          [
            "a field three levels into a stance",
            (cell) =>
              cell.key(entryKey).key("stance").key("prefs").key("spice").key(
                "level",
              ).set(2),
          ],
          [
            "a removal three levels into a stance",
            (cell) =>
              cell.key(entryKey).key("stance").key("prefs").key("spice").set(
                {},
              ),
          ],
          [
            "a removal inside a stance",
            (cell) =>
              cell.key(entryKey).key("stance").set({
                choice: "sushi",
                budget: 40,
              }),
          ],
          ["a new entry", (cell) => cell.key("forged").set({ stance: {} })],
          ["a new entry, as a string", (cell) => cell.key("forged").set("x")],
          [
            "an entry's terms",
            (cell) => cell.key(entryKey).key("terms").set("{}"),
          ],
          ["every entry, removed", (cell) => cell.set({})],
          ["an entry, removed", (cell) => cell.key(entryKey).set(undefined)],
        ];
        const outcomes: Record<string, boolean> = {};
        for (const [where, write] of writes) {
          const tx = runtime.edit();
          tx.setCfcImplementationIdentity({
            kind: "verified",
            moduleIdentity: "sha256:attacker",
            symbol: "overwrite",
            bindingPath: ["overwrite"],
          });
          write(local.withTx(tx) as Cell<unknown>);
          outcomes[where] = (await tx.commit()).error !== undefined;
        }
        expect(outcomes).toEqual(
          Object.fromEntries(writes.map(([where]) => [where, true])),
        );
        expect(local.getRaw()).toEqual(before);
      } finally {
        await fixture.dispose();
      }
    });

    it("leaves the projector no witness after other code replaces the whole box with a primitive", async () => {
      // The runtime does not refuse this one write: a primitive written over
      // the root of a document whose writer claim is on that root. What keeps
      // it from laundering anything is that the replacement is not the seal's,
      // so the projector's inputs no longer carry the seal's witness.
      const fixture = await setup();
      try {
        const { box } = await fixture.seal(alice);
        await fixture.seal(bob);
        const runtime = fixture.runtimes.get(carol)!;
        await syncManifest(runtime);
        const local = runtime.getCellFromLink(box.getAsNormalizedFullLink());
        await local.sync();
        const tx = runtime.edit();
        tx.setCfcImplementationIdentity({
          kind: "verified",
          moduleIdentity: "sha256:attacker",
          symbol: "replace",
          bindingPath: ["replace"],
        });
        local.withTx(tx).set("gone" as never);
        expect((await tx.commit()).error).toBeUndefined();
        const integrity = await project(fixture, carol, box);
        expect(integrity).toContainEqual({
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: PROJECT,
        });
        expect(integrity).not.toContainEqual(witnessed);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a box or an anchor that other code created first", async () => {
      // Both addresses are derivable by anyone who can read the terms, so a
      // member's code can create either one before the first seal.
      for (const squatted of ["custodyBox", "custodyAnchor"] as const) {
        const fixture = await setup();
        try {
          const instance = hashStringOf(TERMS);
          const runtime = fixture.runtimes.get(mallory)!;
          const tx = runtime.edit();
          tx.setCfcImplementationIdentity({
            kind: "verified",
            moduleIdentity: "sha256:attacker",
            symbol: "squat",
            bindingPath: ["squat"],
          });
          // The anchor squat holds the seal's own constant, so only its
          // label differs from what the seal would write.
          runtime.getCell(S, { [squatted]: { policy: P, instance } }, {
            type: "object",
          }, tx).set(
            (squatted === "custodyAnchor" ? { instance } : {}) as never,
          );
          expect((await tx.commit()).error).toBeUndefined();
          const refusal = fixture.seal(alice);
          await expect(refusal).rejects.toThrow(
            squatted === "custodyBox"
              ? /box the seal did not create/
              : /anchor the seal did not create/,
          );
        } finally {
          await fixture.dispose();
        }
      }
    });

    it("refuses an anchor other code created with the seal's own label but a link for its value", async () => {
      // The anchor's label is right; its value redirects to a document
      // labeled for another member, whose clause the seal's read would carry
      // into every entry.
      const fixture = await setup();
      try {
        const instance = hashStringOf(TERMS);
        const runtime = fixture.runtimes.get(alice)!;
        await syncManifest(runtime);
        const tx = runtime.edit();
        tx.setCfcImplementationIdentity({
          kind: "verified",
          moduleIdentity: "sha256:attacker",
          symbol: "squat",
          bindingPath: ["squat"],
        });
        const target = runtime.getCell(S, "bob-tagged", {
          type: "object",
          ifc: {
            confidentiality: [{
              anyOf: [cfcAtom.space(S), cfcAtom.user(bob.did())],
            }],
          },
        } as never, tx);
        target.set({ instance } as never);
        runtime.getCell(S, { custodyAnchor: { policy: P, instance } }, {
          type: "object",
          ifc: {
            confidentiality: [{
              anyOf: [
                { ...P, subject: { __ctOwningSpace: true } },
                cfcAtom.space(S),
              ],
            }],
          },
        } as never, tx).setRaw(target.getAsWriteRedirectLink() as never);
        expect((await tx.commit()).error).toBeUndefined();
        await expect(fixture.seal(alice)).rejects.toThrow(
          /anchor the seal did not create/,
        );
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses an anchor other code created with the seal's own value and clause and integrity of its own", async () => {
      // The anchor is the entry transaction's one labeled read, so integrity
      // stored on it would reach the entries' labels; only its confidentiality
      // is what the seal wrote.
      const fixture = await setup();
      try {
        const instance = hashStringOf(TERMS);
        const runtime = fixture.runtimes.get(mallory)!;
        await syncManifest(runtime);
        const tx = runtime.edit();
        tx.setCfcImplementationIdentity({
          kind: "verified",
          moduleIdentity: "sha256:attacker",
          symbol: "squat",
          bindingPath: ["squat"],
        });
        const squat = runtime.getCell(
          S,
          { custodyAnchor: { policy: P, instance } },
          {
            type: "object",
            ifc: {
              confidentiality: [{
                anyOf: [
                  { ...P, subject: { __ctOwningSpace: true } },
                  cfcAtom.space(S),
                ],
              }],
              integrity: ["squatted-claim"],
            },
          } as never,
          tx,
        );
        squat.set({ instance } as never);
        expect((await tx.commit()).error).toBeUndefined();
        expect(
          storedEntries(runtime, squat).flatMap((entry) =>
            entry.label.integrity ?? []
          ),
        ).toContainEqual("squatted-claim");
        await expect(fixture.seal(alice)).rejects.toThrow(
          /anchor the seal did not create/,
        );
      } finally {
        await fixture.dispose();
      }
    });

    it("writes the actor-private receipt to the actor's home space", async () => {
      const fixture = await setup();
      try {
        const { receipt, entryKey } = await fixture.seal(alice);
        expect(receipt.getAsNormalizedFullLink().space).toBe(alice.did());
        expect(receipt.get()).toMatchObject({
          entryKey,
          policy: P,
          sources: [],
        });
        const tx = fixture.runtimes.get(alice)!.edit();
        const entries = readStoredCfcMetadata(
          tx,
          receipt.getAsNormalizedFullLink(),
        )?.labelMap.entries ?? [];
        tx.abort();
        expect(entries.flatMap((entry) => entry.label.confidentiality ?? []))
          .toContainEqual(cfcAtom.user(alice.did()));
      } finally {
        await fixture.dispose();
      }
    });
  });

  describe("actor-owned clauses", () => {
    it("seals a multi-facet value drawn from the actor's own sources and reports them", async () => {
      const fixture = await setup();
      try {
        const sources = [
          context(owner(alice), "calendar"),
          resource(owner(alice)),
        ];
        const draft = await fixture.draft(alice, honestStance, [
          owner(alice),
          {
            anyOf: [context(owner(alice), "calendar"), resource(owner(alice))],
          },
          cfcAtom.user(owner(alice)),
        ]);
        const prepared = await prepareCustodySeal(draft, fixture.room(alice), {
          allowedSources: sources,
        });
        expect(prepared.sources).toEqual(sources);
        expect(Object.isFrozen(prepared.sources)).toBe(true);
        expect(Object.isFrozen(prepared.readers)).toBe(true);
        expect(prepared.readers.every(Object.isFrozen)).toBe(true);
        expect(prepared.stance).toEqual(honestStance);
        await commitCustodySeal(prepared.consent, trustedClick());
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a value labeled for another DID, naming both DIDs", async () => {
      const fixture = await setup();
      try {
        const rotated = await Identity.fromPassphrase("custody-seal-old-key");
        for (
          const clause of [
            cfcAtom.user(rotated.did()),
            context(rotated.did()),
            rotated.did(),
            { anyOf: [cfcAtom.user(alice.did()), cfcAtom.user(bob.did())] },
          ]
        ) {
          const draft = await fixture.draft(alice, honestStance, [clause]);
          const refusal = prepareCustodySeal(draft, fixture.room(alice));
          await expect(refusal).rejects.toThrow(/identity mismatch/);
          await expect(refusal).rejects.toThrow(alice.did());
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("seals a draft labeled for the actor's home space", async () => {
      // The actor's home space is the space whose DID is the actor's own, and
      // its access list is the actor's to write.
      const fixture = await setup();
      try {
        for (
          const [index, label] of [
            [cfcAtom.space(alice.did())],
            [cfcAtom.personalSpace(alice.did())],
            [{
              anyOf: [cfcAtom.space(alice.did()), cfcAtom.user(alice.did())],
            }],
          ].entries()
        ) {
          const draft = await fixture.draft(
            alice,
            honestStance,
            label,
            `home-draft-${index}`,
          );
          const prepared = await prepareCustodySeal(draft, fixture.room(alice));
          expect(prepared.sources).toEqual([]);
        }
        const draft = await fixture.draft(alice, honestStance, [
          cfcAtom.space(alice.did()),
        ], "home-draft-sealed");
        const prepared = await prepareCustodySeal(draft, fixture.room(alice));
        await commitCustodySeal(prepared.consent, trustedClick());
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses another principal's space, including one whose id is another member's DID", async () => {
      const fixture = await setup();
      try {
        for (
          const clause of [
            cfcAtom.space(bob.did()),
            cfcAtom.space(S),
            cfcAtom.personalSpace(bob.did()),
            { ...cfcAtom.space(alice.did()), role: "reader" },
            { ...cfcAtom.personalSpace(alice.did()), scope: "work" },
          ]
        ) {
          const draft = await fixture.draft(alice, honestStance, [clause]);
          await expect(prepareCustodySeal(draft, fixture.room(alice)))
            .rejects.toThrow(/does not own/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a foreign clause", async () => {
      const fixture = await setup();
      try {
        for (
          const clause of [
            cfcAtom.space(bob.did()),
            "private-policy",
            policyOf(SCRATCH),
            cfcAtom.expires(Date.now() + 60_000),
            { ...P, subject: bob.did() },
          ]
        ) {
          const draft = await fixture.draft(alice, honestStance, [clause]);
          await expect(prepareCustodySeal(draft, fixture.room(alice)))
            .rejects.toThrow(/does not own/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a hashed or extra-key `Context` and an extra-key `Resource`", async () => {
      const fixture = await setup();
      try {
        for (
          const clause of [
            { ...context(owner(alice)), hash: "sha256:record" },
            { ...context(owner(alice)), scope: "work" },
            { ...resource(owner(alice)), scope: "work" },
            { ...cfcAtom.user(owner(alice)), role: "admin" },
          ]
        ) {
          const draft = await fixture.draft(alice, honestStance, [clause]);
          await expect(prepareCustodySeal(draft, fixture.room(alice)))
            .rejects.toThrow(/does not own/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a caveat left on the value", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance, [
          cfcAtom.user(owner(alice)),
          {
            anyOf: [
              cfcAtom.user(owner(alice)),
              cfcAtom.caveat("prompt-injection", context(owner(alice))),
            ],
          },
        ]);
        await expect(prepareCustodySeal(draft, fixture.room(alice)))
          .rejects.toThrow(/still carries a caveat/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses an unsatisfiable clause", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance, [{ anyOf: [] }]);
        await expect(prepareCustodySeal(draft, fixture.room(alice)))
          .rejects.toThrow(/unsatisfiable clause/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a source the room does not allow", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance, [
          context(owner(alice), "health"),
        ]);
        await expect(
          prepareCustodySeal(draft, fixture.room(alice), {
            allowedSources: [context(owner(alice), "calendar")],
          }),
        ).rejects.toThrow(/source this room does not allow/);
      } finally {
        await fixture.dispose();
      }
    });
  });

  describe("the room", () => {
    it("refuses a policy the actor does not trust", async () => {
      for (
        const trust of [
          undefined,
          {
            ...TRUST,
            statements: [{
              ...TRUST.statements![0],
              concrete: {
                ...TRUST.statements![0].concrete as object,
                symbol: "scratchRules",
              },
            }],
          },
        ]
      ) {
        const fixture = await setup({ trust });
        try {
          const draft = await fixture.draft(alice, honestStance);
          await expect(prepareCustodySeal(draft, fixture.room(alice)))
            .rejects.toThrow(/does not trust as a declassifier/);
        } finally {
          await fixture.dispose();
        }
      }
    });

    it("refuses a trust statement that leaves the manifest digest open", async () => {
      // A manifest's module identity and symbol are its author's to write, so
      // a statement naming only those two is met by anyone's manifest.
      const concrete = { ...TRUST.statements![0].concrete as object };
      delete (concrete as { policyDigest?: unknown }).policyDigest;
      const fixture = await setup({
        trust: {
          ...TRUST,
          statements: [{ ...TRUST.statements![0], concrete }],
        },
      });
      try {
        const draft = await fixture.draft(alice, honestStance);
        await expect(prepareCustodySeal(draft, fixture.room(alice)))
          .rejects.toThrow(/does not trust as a declassifier/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a preparation that names no allowed sources", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance);
        await expect(
          prepareWithOptions(draft, fixture.room(alice), undefined as never),
        ).rejects.toThrow(/allowed sources/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a policy cell or source policy held by another runtime", async () => {
      // A handle from another runtime would be read under that runtime's
      // actor and replica, not the one the seal checks and writes as.
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance);
        const elsewhere = fixture.runtimes.get(bob)!;
        const foreign = elsewhere.getCell(alice.did(), "foreign-handle");
        await expect(
          prepareCustodySeal(draft, fixture.room(alice), {
            allowedSources: foreign,
          }),
        ).rejects.toThrow(/same runtime/);
        await expect(
          prepareCustodySeal(draft, {
            ...fixture.room(alice),
            policy: foreign,
          }),
        ).rejects.toThrow(/same runtime/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a policy whose subject is not the room space", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance);
        await expect(
          prepareCustodySeal(
            draft,
            fixture.room(alice, policyOf(CUSTODY, bob.did())),
          ),
        ).rejects.toThrow(/is not the room space/);
        await expect(
          prepareCustodySeal(
            draft,
            fixture.room(alice, { ...P, extra: true } as unknown as never),
          ),
        ).rejects.toThrow(/exact module policy reference/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses terms that carry a clause the room's readers do not hold", async () => {
      const fixture = await setup();
      try {
        const runtime = fixture.runtimes.get(alice)!;
        const cases = [
          [cfcAtom.user(bob.did()), false],
          [cfcAtom.space(bob.did()), false],
          [cfcAtom.space(S), true],
          [{ anyOf: [cfcAtom.user(bob.did()), cfcAtom.space(S)] }, true],
        ] as const;
        for (const [index, [clause, accepted]] of cases.entries()) {
          const tx = runtime.edit();
          const terms = runtime.getCell(S, `labeled-terms-${index}`, {
            type: "object",
            ifc: { confidentiality: [clause] },
          } as never, tx);
          terms.set(TERMS as never);
          expect((await tx.commit()).error).toBeUndefined();
          const draft = await fixture.draft(alice, honestStance);
          const prepared = prepareCustodySeal(draft, {
            terms: terms.withTx(undefined),
            policy: P,
          });
          if (accepted) {
            await expect(prepared).resolves.toBeDefined();
          } else {
            await expect(prepared).rejects.toThrow(
              /terms carry a clause the room's readers do not hold/,
            );
          }
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a policy that is not installed in the room space", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance);
        const unknown = artifactFor("custodyRules2");
        await expect(
          prepareCustodySeal(draft, fixture.room(alice, policyOf(unknown))),
        ).rejects.toThrow(/not installed in the room space/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses an actor the terms give no seat", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(mallory, honestStance);
        await expect(prepareCustodySeal(draft, fixture.room(mallory)))
          .rejects.toThrow(/gives it no seat|give it no seat/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses terms whose seats are not all well-formed DIDs", async () => {
      for (
        const seat of [
          `${bob.did()} (you)`,
          `did:key:\u202euoy\u202c`,
          `did:key:z6Mk\ufeffBob`,
          `did:key:${"z".repeat(300)}`,
          "did:web:example.com:",
        ]
      ) {
        const fixture = await setup({
          terms: { ...TERMS, seats: [...TERMS.seats, seat] },
        });
        try {
          const draft = await fixture.draft(alice, honestStance);
          await expect(prepareCustodySeal(draft, fixture.room(alice)))
            .rejects.toThrow(/distinct, well-formed DIDs/);
        } finally {
          await fixture.dispose();
        }
      }
    });

    it("refuses a stance its schema does not bound", async () => {
      const cases: [unknown, unknown, RegExp][] = [
        [
          {
            type: "object",
            properties: { note: { type: "string" } },
            additionalProperties: false,
          },
          { note: "free text" },
          /admits open-ended values/,
        ],
        [
          STANCE_SCHEMA,
          { choice: "sushi", budget: 900 },
          /outside the number's bounds/,
        ],
        [
          STANCE_SCHEMA,
          { choice: "ramen", budget: 1 },
          /not one of the enumerated values/,
        ],
        [
          STANCE_SCHEMA,
          { choice: "sushi", budget: 1, extra: true },
          /is not declared/,
        ],
        [
          { ...STANCE_SCHEMA, additionalProperties: true },
          honestStance,
          /additionalProperties: false/,
        ],
        [
          { type: "array", items: { type: "boolean" }, maxItems: 2 },
          [true],
          /keyword `items`/,
        ],
        [{ anyOf: [{ type: "boolean" }] }, true, /keyword `anyOf`/],
        [
          {
            ...STANCE_SCHEMA,
            properties: {
              ...STANCE_SCHEMA.properties,
              note: { type: "string" },
            },
          },
          honestStance,
          /admits open-ended values at `\/note`/,
        ],
      ];
      for (const [stanceSchema, stance, refusal] of cases) {
        const fixture = await setup({ terms: { ...TERMS, stanceSchema } });
        try {
          const draft = await fixture.draft(alice, stance as FabricValue);
          await expect(prepareCustodySeal(draft, fixture.room(alice)))
            .rejects.toThrow(refusal);
        } finally {
          await fixture.dispose();
        }
      }
    });

    it("refuses when the storage signer is not the acting principal", async () => {
      const fixture = await setup();
      try {
        const impostor = fixture.runtimeFor(alice, bob);
        impostor.registerCfcPolicyManifests(undefined, [CUSTODY]);
        fixture.runtimes.set(alice, impostor);
        const draft = await fixture.draft(alice, honestStance);
        await expect(prepareCustodySeal(draft, fixture.room(alice)))
          .rejects.toThrow(/storage signer/);
      } finally {
        await fixture.dispose();
      }
    });
  });

  describe("consent", () => {
    it("refuses an untrusted click, the wrong surface, and forged or replayed consent", async () => {
      const fixture = await setup();
      try {
        await expect(
          commitCustodySeal({} as CustodySealConsent, trustedClick()),
        ).rejects.toThrow(/unknown or already consumed/);
        const draft = await fixture.draft(alice, honestStance);
        for (
          const event of [
            {
              type: "click",
              provenance: {
                origin: "dom",
                trusted: true,
                ui: { pattern: "CustodySeal" },
              },
            },
            trustedClick("ShareSnapshot"),
            undefined,
          ]
        ) {
          const prepared = await prepareCustodySeal(draft, fixture.room(alice));
          await expect(commitCustodySeal(prepared.consent, event))
            .rejects.toThrow(/trusted host seal gesture/);
        }
        const genuine = await prepareCustodySeal(draft, fixture.room(alice));
        await commitCustodySeal(genuine.consent, trustedClick());
        await expect(commitCustodySeal(genuine.consent, trustedClick()))
          .rejects.toThrow(/already consumed/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a value changed after review", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance);
        const prepared = await prepareCustodySeal(draft, fixture.room(alice));
        const runtime = fixture.runtimes.get(alice)!;
        const tx = runtime.edit();
        (draft.withTx(tx) as Cell<{ budget: number }>).key("budget").set(41);
        expect((await tx.commit()).error).toBeUndefined();
        await expect(commitCustodySeal(prepared.consent, trustedClick()))
          .rejects.toThrow(/review is stale/);
      } finally {
        await fixture.dispose();
      }
    });

    it("writes one entry when the same actor commits two reviews at once", async () => {
      const fixture = await setup();
      try {
        // Two drafts with different values, as from two devices, so that a
        // second write over the first would show in the stored entry.
        const phone = await fixture.draft(alice, honestStance);
        const laptop = await fixture.draft(
          alice,
          { choice: "tacos", budget: 9 },
          [cfcAtom.user(alice.did())],
          "laptop-draft",
        );
        const first = await prepareCustodySeal(phone, fixture.room(alice));
        const second = await prepareCustodySeal(laptop, fixture.room(alice));
        const outcomes = await Promise.allSettled([
          commitCustodySeal(first.consent, trustedClick()),
          commitCustodySeal(second.consent, trustedClick()),
        ]);
        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
          "fulfilled",
          "rejected",
        ]);
        const sealed = outcomes.find((outcome) =>
          outcome.status === "fulfilled"
        ) as PromiseFulfilledResult<{ box: Cell<unknown>; entryKey: string }>;
        const winner = outcomes[0].status === "fulfilled"
          ? honestStance
          : { choice: "tacos", budget: 9 };
        const box = sealed.value.box;
        await box.sync();
        const entries = box.getRaw() as Record<string, { stance: unknown }>;
        expect(Object.keys(entries)).toEqual([sealed.value.entryKey]);
        expect(entries[sealed.value.entryKey].stance).toEqual(winner);
      } finally {
        await fixture.dispose();
      }
    });

    it("seals both actors when two first seals race to create the anchor", async () => {
      // Each runtime finds no anchor and creates one; the loser's create
      // fails, and it has to find the winner's anchor rather than give up
      // after its consent is spent and its receipt written.
      const fixture = await setup();
      try {
        const drafts = await Promise.all(
          [alice, bob, carol].map((identity) =>
            fixture.draft(identity, honestStance)
          ),
        );
        const prepared = await Promise.all(
          [alice, bob, carol].map((identity, index) =>
            prepareCustodySeal(drafts[index], fixture.room(identity))
          ),
        );
        const outcomes = await Promise.allSettled(
          prepared.map(({ consent }) =>
            commitCustodySeal(consent, trustedClick())
          ),
        );
        expect(
          outcomes.map((outcome) =>
            outcome.status === "rejected"
              ? String(outcome.reason)
              : outcome.status
          ),
        ).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
        const results = outcomes.map((outcome) =>
          (outcome as PromiseFulfilledResult<
            { box: Cell<unknown>; entryKey: string }
          >).value
        );
        const box = results[results.length - 1].box;
        await box.sync();
        expect(Object.keys(box.getRaw() as object).sort()).toEqual(
          results.map((result) => result.entryKey).sort(),
        );
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a second entry for an actor who already sealed", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance);
        const first = await prepareCustodySeal(draft, fixture.room(alice));
        const second = await prepareCustodySeal(draft, fixture.room(alice));
        await commitCustodySeal(first.consent, trustedClick());
        await expect(commitCustodySeal(second.consent, trustedClick()))
          .rejects.toThrow(/second entry for this actor/);
        await expect(prepareCustodySeal(draft, fixture.room(alice)))
          .rejects.toThrow(/second entry for this actor/);
      } finally {
        await fixture.dispose();
      }
    });
  });

  describe("the room's readers", () => {
    it("names the actor, the room, and the room's readers from its access list", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance);
        const prepared = await prepareCustodySeal(draft, fixture.room(alice));
        expect(prepared.actor).toBe(alice.did());
        expect(prepared.room).toBe(S);
        // The room's key is an owner although the list does not name it.
        const expected = [
          { principal: S, role: "owner" },
          { principal: carol.did(), role: "owner" },
          ...[alice, bob, mallory].map((member) => ({
            principal: member.did(),
            role: "writer",
          })),
        ].sort((a, b) => utf8Compare(a.principal, b.principal));
        expect(prepared.readers).toEqual(expected);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a room space with no access list", async () => {
      const fixture = await setup({ acl: false });
      try {
        const draft = await fixture.draft(alice, honestStance);
        await expect(prepareCustodySeal(draft, fixture.room(alice)))
          .rejects.toThrow(/access list names its readers/);
      } finally {
        await fixture.dispose();
      }
    });

    it("admits `*` as a reader of the room", async () => {
      const fixture = await setup();
      try {
        await fixture.roomAcl.set("*", "READ");
        const draft = await fixture.draft(alice, honestStance);
        const prepared = await prepareCustodySeal(draft, fixture.room(alice));
        expect(prepared.readers[0]).toEqual({ principal: "*", role: "reader" });
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a room whose access list names a principal that is not a well-formed DID", async () => {
      const hostile = [
        `${alice.did()} (you)`,
        `did:key:\u202euoy\u202c`,
        `did:key:z6Mk\u200bAlice`,
        `did:key:${"z".repeat(300)}`,
      ];
      for (const principal of hostile) {
        const fixture = await setup();
        try {
          await fixture.roomAcl.set(principal as `did:${string}`, "READ");
          const draft = await fixture.draft(alice, honestStance);
          await expect(prepareCustodySeal(draft, fixture.room(alice)))
            .rejects.toThrow(/names only well-formed DIDs or `\*`/);
        } finally {
          await fixture.dispose();
        }
      }
    });

    it("refuses a seal whose room gained a reader after review", async () => {
      const fixture = await setup();
      try {
        const draft = await fixture.draft(alice, honestStance);
        const prepared = await prepareCustodySeal(draft, fixture.room(alice));
        const eve = await Identity.fromPassphrase("custody-seal-eve");
        await fixture.roomAcl.set(eve.did(), "READ");
        await expect(commitCustodySeal(prepared.consent, trustedClick()))
          .rejects.toThrow(/review is stale/);
      } finally {
        await fixture.dispose();
      }
    });
  });

  describe("the actor's source policy", () => {
    /** Writes a settings document holding `value` into `space`. */
    const settings = async (
      fixture: Fixture,
      space: string,
      value: unknown,
      cause = "custody-sources",
    ) => {
      const runtime = fixture.runtimes.get(alice)!;
      const tx = runtime.edit();
      const cell = runtime.getCell(space as never, cause, {
        ifc: { confidentiality: [cfcAtom.user(alice.did())] },
      } as never, tx);
      cell.set(value as never);
      expect((await tx.commit()).error).toBeUndefined();
      return cell.withTx(undefined);
    };

    it("reads the actor's own sources from the actor's home space", async () => {
      const fixture = await setup();
      try {
        const sources = [
          context(owner(alice), "calendar"),
          resource(owner(alice)),
        ];
        const cell = await settings(fixture, alice.did(), sources);
        expect(await readCustodySourcePolicy(cell)).toEqual(sources);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a policy outside the actor's home space", async () => {
      const fixture = await setup();
      try {
        const cell = await settings(fixture, S, [context(owner(alice))]);
        await expect(readCustodySourcePolicy(cell)).rejects.toThrow(
          /only from the actor's home space/,
        );
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a policy naming another principal's source or another shape", async () => {
      const fixture = await setup();
      try {
        for (
          const value of [
            [context(owner(bob))],
            [cfcAtom.user(alice.did())],
            [{ ...context(owner(alice)), hash: "sha256:x" }],
            { calendar: true },
          ]
        ) {
          const cell = await settings(
            fixture,
            alice.did(),
            value,
            `custody-sources-${JSON.stringify(value)}`,
          );
          await expect(readCustodySourcePolicy(cell)).rejects.toThrow(
            /the actor's own `Context` and `Resource` atoms/,
          );
        }
      } finally {
        await fixture.dispose();
      }
    });
  });

  it("is not importable from a pattern", () => {
    expect(
      isAllowedAuthoredImportSpecifier("@commonfabric/runner/cfc/custody-seal"),
    ).toBe(false);
    const { runtimeExports } = getRuntimeModuleExports();
    expect(Object.keys(runtimeExports)).toContain("commonfabric/cfc");
    for (const namespace of Object.values(runtimeExports)) {
      const entries = Object.entries(namespace as object);
      for (const [name, value] of entries) {
        expect(name).not.toMatch(/CustodySeal/);
        expect([prepareCustodySeal, commitCustodySeal]).not.toContain(value);
      }
    }
  });
});

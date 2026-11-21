/**
 * The custody seal's test fixture: four members' runtimes over one memory
 * server, a room space holding public terms, and the room's custody policy
 * installed there, with the identities, policy and terms it uses.
 */

import { expect } from "@std/expect";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity, type Signer } from "@commonfabric/identity";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { refusingServer } from "./refusing-server.ts";
import {
  commitCustodySeal,
  type CustodyRoom,
  type CustodySealOptions,
  prepareCustodySeal as prepareWithOptions,
  TRUSTED_DECLASSIFIER_CONCEPT,
} from "../../src/cfc/custody-seal.ts";
import { ACLManager } from "../../src/acl-manager.ts";
import { buildCfcPolicyArtifactManifest } from "../../src/cfc/policy.ts";
import type { CfcTrustConfigInput } from "../../src/cfc/trust.ts";
import { hostGestureProvenance } from "../../src/cfc/host-review.ts";
import { markRendererTrustedEvent } from "../../src/cfc/ui-contract.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

export const alice = await Identity.fromPassphrase("custody-seal-alice");
export const bob = await Identity.fromPassphrase("custody-seal-bob");
export const carol = await Identity.fromPassphrase("custody-seal-carol");
export const mallory = await Identity.fromPassphrase("custody-seal-mallory");
const roomOwner = await Identity.fromPassphrase("custody-seal-room");
export const S = roomOwner.did();

export const MODULE = "sha256:custody-module";
const REVIEWER = "did:web:review.example";

export const artifactFor = (symbol: string) =>
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

export const CUSTODY = artifactFor("custodyRules");

export const policyOf = (artifact = CUSTODY, subject = S) =>
  cfcAtom.modulePolicyRef(
    MODULE,
    artifact.manifest.symbol,
    artifact.policyDigest,
    subject,
  );

export const P = policyOf();

/** The actor's standing trust: the custody symbol is a trusted declassifier. */
export const TRUST: CfcTrustConfigInput = {
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

export const STANCE_SCHEMA = {
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

export const TERMS = {
  question: "Where should we eat?",
  seats: [alice.did(), bob.did(), carol.did()],
  stanceSchema: STANCE_SCHEMA,
};

/** Prepares with no sources allowed beyond the actor's own `User` clauses. */
export const prepareCustodySeal = (
  draft: Cell<unknown>,
  room: CustodyRoom,
  options: CustodySealOptions = { allowedSources: [] },
) => prepareWithOptions(draft, room, options);

/** Creates the renderer-side mark attached only by the trusted host. */
export const trustedClick = (pattern = "CustodySeal") => {
  const event = {
    type: "click",
    provenance: hostGestureProvenance(pattern),
  };
  markRendererTrustedEvent(event);
  return event;
};

export type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * Four members' runtimes over one memory server, each signing as its own
 * identity, a room space holding public terms, and the room's custody policy
 * installed there.
 */
export const setup = async (
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
  // Every runtime reaches the server through this stand-in, so a test can
  // have it refuse a space from some point on.
  const refusing = refusingServer(server);
  const managers: EmulatedStorageManager[] = [];
  const created: Runtime[] = [];
  /**
   * A runtime acting for `identity`, signing as `signer`. `posture.actor`
   * names the acting principal each transaction is opened under, and
   * `posture.readCeiling` the runtime's read ceiling.
   */
  const runtimeFor = (
    identity: Identity,
    signer: Signer = identity,
    posture: {
      actor?: () => string;
      readCeiling?: readonly CfcConfClause[];
    } = {},
  ): Runtime => {
    const storageManager = EmulatedStorageManager.connectTo(
      refusing.server as MemoryV2Server.Server,
      { as: signer },
    );
    managers.push(storageManager);
    const actor = posture.actor ?? (() => identity.did());
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      trustSnapshotProvider: () => ({
        id: identity.did(),
        actingPrincipal: actor(),
      }),
      ...(trust === undefined ? {} : { cfcTrustConfig: trust }),
      ...(posture.readCeiling === undefined
        ? {}
        : { cfcReadMaxConfidentiality: posture.readCeiling }),
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
  // The room document whose cells receive the seal's links.
  host.getCell(S, "room-cells", undefined, install).set({} as never);
  expect((await install.commit().settled).error).toBeUndefined();
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
    /** From now on, refuses every request naming `space`. */
    refuse: (space: string) => refusing.refuse(space, "unauthorized"),
    terms: terms.withTx(undefined),
    room(identity: Identity, policy = P, box?: Cell<unknown>): CustodyRoom {
      const runtime = runtimes.get(identity)!;
      return {
        terms: runtime.getCellFromLink(terms.getAsNormalizedFullLink()),
        policy,
        ...(box === undefined
          ? {}
          : { box: runtime.getCellFromLink(box.getAsNormalizedFullLink()) }),
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
      expect((await tx.commit().settled).error).toBeUndefined();
      return cell.withTx(undefined);
    },
    /**
     * Writes a cell in the room space whose stored label attests each of
     * `subjects` with a root `represents-principal` atom, the evidence a
     * principal's own runtime mints on a cell it creates.
     */
    async attestation(
      subjects: readonly string[],
      cause: string,
      atoms: readonly unknown[] = subjects.map((subject) => ({
        kind: "represents-principal",
        subject,
      })),
      confidentiality?: readonly unknown[],
    ): Promise<Cell<unknown>> {
      const runtime = runtimes.get(alice)!;
      const tx = runtime.edit();
      const cell = runtime.getCell(S, cause, undefined, tx);
      writeSeedEnvelopeDoc(tx, S);
      seedStoredEnvelope(tx, {
        space: S,
        scope: "space",
        id: cell.getAsNormalizedFullLink().id,
        path: [],
      }, {
        value: {},
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                integrity: [...atoms],
                ...(confidentiality === undefined ? {} : { confidentiality }),
              },
            }],
          },
        },
      } as FabricValue);
      expect((await tx.commit().settled).error).toBeUndefined();
      return cell.withTx(undefined);
    },
    /** Replaces the room's terms; a seat given as a cell is stored as a link. */
    async setTerms(value: Record<string, unknown>): Promise<void> {
      const runtime = runtimes.get(alice)!;
      const tx = runtime.edit();
      runtime.getCellFromLink(terms.getAsNormalizedFullLink(), undefined, tx)
        .set(value as never);
      expect((await tx.commit().settled).error).toBeUndefined();
    },
    /** Prepares and commits one seal with a trusted click. */
    async seal(
      identity: Identity,
      value: FabricValue = honestStance,
      box?: Cell<unknown>,
    ) {
      const draft = await fixture.draft(identity, value);
      const prepared = await prepareCustodySeal(
        draft,
        fixture.room(identity, P, box),
      );
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

export const honestStance = {
  choice: "sushi",
  budget: 40,
  prefs: { spice: { level: 1 } },
};

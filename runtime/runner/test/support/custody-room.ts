/**
 * A custody room over one shared memory server: three members' runtimes, a
 * room space whose custody policy is installed and trusted, and helpers that
 * seal a member's choice, run the room's projector, and publish or read the
 * answer. Shared so a test of a host's view of the answer runs the same seal
 * the runner's own custody answer tests do.
 */

import { expect } from "@std/expect";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
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
  CUSTODY_SEAL_READER,
  type CustodyRoom,
  prepareCustodySeal,
  publishCustodyAnswer,
  readCustodyAnswer,
  TRUSTED_DECLASSIFIER_CONCEPT,
} from "../../src/cfc/custody-seal.ts";
import { ACLManager } from "../../src/acl-manager.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../../src/cfc/policy.ts";
import type { CfcTrustConfigInput } from "../../src/cfc/trust.ts";
import type { ImplementationIdentity } from "../../src/cfc/types.ts";
import { hostGestureProvenance } from "../../src/cfc/host-review.ts";
import { markRendererTrustedEvent } from "../../src/cfc/ui-contract.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { setCfcImplementationIdentity } from "../../src/storage/extended-storage-transaction.ts";

export const alice = await Identity.fromPassphrase("custody-answer-alice");
export const bob = await Identity.fromPassphrase("custody-answer-bob");
export const mallory = await Identity.fromPassphrase("custody-answer-mallory");
const roomOwner = await Identity.fromPassphrase("custody-answer-room");
export const S = roomOwner.did();

export const MODULE = "sha256:custody-answer-module";
const REVIEWER = "did:web:review.example";

const SEALED_BY = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: { kind: "builtin", builtinId: "cfc-custody-seal" },
};

export const PROJECT: ImplementationIdentity = {
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
export const OTHER_MODULE = "sha256:custody-answer-other-module";
export const otherArtifact = buildCfcPolicyArtifactManifest({
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

export type CustodyRoomFixture = Awaited<ReturnType<typeof custodyRoom>>;

/** Three members' runtimes over one server, and a room whose policy is
 * installed in its space. */
export const custodyRoom = async ({ witnessed = true, toSeal = true } = {}) => {
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
  // Every runtime reaches the server through this stand-in, so a test can
  // have it refuse a space from some point on.
  const refusing = refusingServer(server);
  const managers: EmulatedStorageManager[] = [];
  const created: Runtime[] = [];
  const runtimeFor = (identity: Identity): Runtime => {
    const storageManager = EmulatedStorageManager.connectTo(
      refusing.server as MemoryV2Server.Server,
      { as: identity },
    );
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
    /** From now on, refuses every request naming `space`. */
    refuse: (space: string) => refusing.refuse(space, "unauthorized"),
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

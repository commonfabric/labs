/**
 * Checks host trust options through worker construction and display admission.
 * Real cells and ACL changes drive an in-process renderer over emulated storage.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { VDomOp } from "@commonfabric/html/vdom-ops";
import {
  WorkerReconciler,
  type WorkerRenderNode,
} from "@commonfabric/html/worker";
import { createSession, Identity } from "@commonfabric/identity";
import { createRuntimeClientOptions } from "@commonfabric/lib-shell/runtime";
import {
  Runtime,
  runtimePresets,
  RuntimeTelemetry,
} from "@commonfabric/runner";
import { buildCfcPolicyArtifactManifest } from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";

import {
  browserWorkerParamsFromInitializationData,
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  renderModulePolicySourceFor,
} from "@/backends/runtime-processor.ts";

/** Builds the worker's effective runtime from host options over local storage. */
function createWorkerRuntime(
  options: ReturnType<typeof createRuntimeClientOptions>,
): Runtime {
  const storageManager = StorageManager.emulate({ as: options.identity });
  const params = browserWorkerParamsFromInitializationData(
    {
      ...options,
      apiUrl: options.apiUrl.toString(),
      identity: options.identity.keyPair,
      spaceIdentity: options.spaceIdentity?.keyPair,
    },
    storageManager,
    new RuntimeTelemetry(),
  );
  return new Runtime(runtimePresets.browserWorker(params));
}

/**
 * The manifest `packages/patterns/cfc-exchange-rules/direct-release.tsx`
 * compiles for `directReleaseRules`: a holder of `HasRole(reader)` on the
 * policy's subject space gains `User(reader)`.
 */
const directReleaseManifest = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "UsUHkONMerVZwnUOIBrbzrUlhEfaV0SByvpFqW28WLg",
  symbol: "directReleaseRules",
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "releaseToSpaceReader",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{
          type: CFC_ATOM_TYPE.HasRole,
          principal: { var: "reader" },
          space: { thisPolicyField: "subject" },
          role: "reader",
        }],
      },
      postCondition: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "reader" },
        }],
        integrity: [],
      },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

/** Text sent to the host, including updates to an existing text node. */
function emittedText(ops: readonly VDomOp[]): string[] {
  return ops.filter((op) => op.op === "create-text" || op.op === "update-text")
    .map((op) => op.text);
}

describe("render-audience", () => {
  describe("effective worker trust", () => {
    for (const trustSnapshot of [undefined, null]) {
      it(`uses session-principal transaction trust for \`${trustSnapshot}\` host trust`, async () => {
        const identity = await Identity.generate({ implementation: "noble" });
        const session = await createSession({
          identity,
          spaceDid: identity.did(),
        });
        const options = createRuntimeClientOptions({
          session,
          apiUrl: new URL("http://localhost/"),
          trustSnapshot,
        });
        await using runtime = createWorkerRuntime(options);
        const tx = runtime.edit();
        try {
          const trust = tx.getCfcState().trustSnapshot;
          expect(trust?.id).toBe(`principal:${identity.did()}`);
          expect(trust?.actingPrincipal).toBe(identity.did());
          if (trustSnapshot === null) {
            expect(trust?.revision).toBeDefined();
          }
        } finally {
          tx.abort();
        }
      });
    }

    it("keeps a supplied snapshot unnamed for transactions while rendering as the session identity", async () => {
      const identity = await Identity.generate({ implementation: "noble" });
      const session = await createSession({
        identity,
        spaceDid: identity.did(),
      });
      const trustSnapshot = { id: "unnamed-host-snapshot" };
      const options = createRuntimeClientOptions({
        session,
        apiUrl: new URL("http://localhost/"),
        cfcRenderCeiling: true,
        trustSnapshot,
      });
      await using runtime = createWorkerRuntime(options);
      const tx = runtime.edit();
      try {
        expect(tx.getCfcState().trustSnapshot).toEqual(trustSnapshot);
        expect(tx.getCfcState().trustSnapshot?.actingPrincipal).toBeUndefined();
      } finally {
        tx.abort();
      }
      const membership = renderMembershipProviderFor(
        runtime,
        identity,
        options.renderConfidentialityCeiling,
      );
      expect(membership?.readerRole(identity.did())).toBe("owner");
      expect(options.renderConfidentialityCeiling?.atoms).toContainEqual(
        cfcAtom.user(identity.did()),
      );
    });
  });

  describe("delegated rendering", () => {
    for (const namedSpace of [false, true]) {
      it(`renders the session's ${namedSpace ? "derived" : "identity"} workspace only while the delegate has an ACL grant`, async () => {
        const identity = await Identity.generate({ implementation: "noble" });
        const delegate = await Identity.generate({ implementation: "noble" });
        const session = await createSession({
          identity,
          ...(namedSpace ? { spaceName: "private-workspace" } : {
            spaceDid: identity.did(),
          }),
        });
        const options = createRuntimeClientOptions({
          session,
          apiUrl: new URL("http://localhost/"),
          cfcRenderCeiling: true,
          trustSnapshot: {
            id: `principal:${delegate.did()}`,
            actingPrincipal: delegate.did(),
          },
        });
        await using runtime = createWorkerRuntime(options);
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, session.space);
        const notes = [
          { text: "Workspace note", atom: cfcAtom.space(session.space) },
          { text: "Owner identity note", atom: cfcAtom.user(identity.did()) },
          {
            text: "Owner personal-space note",
            atom: cfcAtom.personalSpace(identity.did()),
          },
          { text: "Owner DID note", atom: identity.did() },
          { text: "Delegate note", atom: cfcAtom.user(delegate.did()) },
        ].map(({ text, atom }) => {
          const cell = runtime.getCell<WorkerRenderNode>(
            session.space,
            text,
            undefined,
            seed,
          );
          seedStoredEnvelope(seed, {
            space: session.space,
            id: cell.getAsNormalizedFullLink().id!,
            type: "application/json",
            path: [],
          }, {
            value: text,
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{ path: [], label: { confidentiality: [atom] } }],
              },
            },
          });
          return cell;
        });
        expect((await seed.commit()).error).toBeUndefined();

        /** Writes the ACL without reading labeled notes into the transaction. */
        async function setDelegateRead(granted: boolean): Promise<void> {
          const tx = runtime.edit();
          tx.writeOrThrow({
            space: session.space,
            id: `of:${session.space}`,
            type: "application/json",
            path: [],
          }, {
            value: {
              [identity.did()]: "OWNER",
              ...(granted ? { [delegate.did()]: "READ" } : {}),
            },
          });
          expect((await tx.commit()).error).toBeUndefined();
          await runtime.storageManager.synced();
          await runtime.idle();
        }

        await setDelegateRead(false);
        const ceiling = options.renderConfidentialityCeiling;
        const membership = renderMembershipProviderFor(
          runtime,
          identity,
          ceiling,
        );
        const resolver = renderConfidentialityResolverFor(
          runtime,
          identity,
          ceiling,
          options.spaceDid,
          membership,
          undefined,
        );
        const ops: VDomOp[] = [];
        const allText: string[] = [];
        const reconciler = new WorkerReconciler({
          onOps: (batch) => {
            ops.push(...batch);
            allText.push(...emittedText(batch));
          },
          renderDeclassificationPolicy: options.renderDeclassificationPolicy,
          renderConfidentialityCeiling: ceiling,
          resolveRenderConfidentiality: resolver,
          membershipProvider: membership,
        });
        const cancel = reconciler.mount({
          type: "vnode",
          name: "div",
          props: {},
          children: notes,
        });
        try {
          await runtime.idle();
          reconciler.flush();
          expect(membership?.readerRole(session.space)).toBeNull();
          expect(emittedText(ops)).toContain("Delegate note");
          expect(emittedText(ops)).toContain("Content hidden by policy");
          expect(emittedText(ops)).not.toContain("Workspace note");
          ops.length = 0;
          await setDelegateRead(true);
          reconciler.flush();
          expect(membership?.readerRole(session.space)).toBe("reader");
          expect(emittedText(ops)).toContain("Workspace note");
          const disclosed = ops.filter((op) => op.op === "create-text")
            .find((op) => op.text === "Workspace note");
          expect(disclosed).toBeDefined();

          ops.length = 0;
          await setDelegateRead(false);
          reconciler.flush();
          expect(membership?.readerRole(session.space)).toBeNull();
          expect(emittedText(ops)).toContain("Content hidden by policy");
          expect(emittedText(ops)).not.toContain("Workspace note");
          expect(ops).toContainEqual({
            op: "remove-node",
            nodeId: disclosed!.nodeId,
          });
          for (
            const text of [
              "Owner identity note",
              "Owner personal-space note",
              "Owner DID note",
            ]
          ) {
            expect(allText).not.toContain(text);
          }
        } finally {
          cancel();
        }
      });
    }
  });

  describe("PolicyOf rendering", () => {
    /**
     * A shell-configured worker rendering one note labeled with the
     * direct-release policy on the session space, as `acting` sees it.
     */
    async function renderPolicyNote(acting?: Identity) {
      const identity = await Identity.generate({ implementation: "noble" });
      const session = await createSession({
        identity,
        spaceDid: identity.did(),
      });
      const viewer = acting ?? identity;
      const options = createRuntimeClientOptions({
        session,
        apiUrl: new URL("http://localhost/"),
        cfcRenderCeiling: true,
        trustSnapshot: {
          id: `principal:${viewer.did()}`,
          actingPrincipal: viewer.did(),
        },
      });
      const runtime = createWorkerRuntime(options);
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, session.space);
      const note = runtime.getCell<WorkerRenderNode>(
        session.space,
        "Policy note",
        undefined,
        seed,
      );
      seedStoredEnvelope(seed, {
        space: session.space,
        id: note.getAsNormalizedFullLink().id!,
        type: "application/json",
        path: [],
      }, {
        value: "Policy note",
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [cfcAtom.modulePolicyRef(
                  directReleaseManifest.manifest.moduleIdentity,
                  directReleaseManifest.manifest.symbol,
                  directReleaseManifest.policyDigest,
                  session.space,
                )],
              },
            }],
          },
        },
      });
      expect((await seed.commit()).error).toBeUndefined();

      const ceiling = options.renderConfidentialityCeiling;
      const membership = renderMembershipProviderFor(
        runtime,
        identity,
        ceiling,
      );
      const manifests = renderModulePolicySourceFor(runtime, ceiling);
      const ops: VDomOp[] = [];
      const reconciler = new WorkerReconciler({
        onOps: (batch) => ops.push(...batch),
        renderDeclassificationPolicy: options.renderDeclassificationPolicy,
        renderConfidentialityCeiling: ceiling,
        resolveRenderConfidentiality: renderConfidentialityResolverFor(
          runtime,
          identity,
          ceiling,
          options.spaceDid,
          membership,
          manifests,
        ),
        membershipProvider: membership,
        modulePolicySource: manifests,
      });
      const cancel = reconciler.mount({
        type: "vnode",
        name: "div",
        props: {},
        children: [note],
      });
      return {
        runtime,
        session,
        identity,
        /** Text emitted since the last call. */
        async settle(): Promise<string[]> {
          await runtime.storageManager.synced();
          await runtime.idle();
          reconciler.flush();
          const text = emittedText(ops);
          ops.length = 0;
          return text;
        },
        /** Installs the manifest the way a labeling commit leaves it. */
        async installManifest(): Promise<void> {
          const tx = runtime.storageManager.edit();
          tx.write({
            space: session.space,
            id: `of:cfc-policy-manifest:${directReleaseManifest.policyDigest}`,
            type: "application/json",
            path: ["value"],
          }, directReleaseManifest as never);
          expect((await tx.commit()).error).toBeUndefined();
        },
        /** Grants or withdraws `acting`'s READ on the session space. */
        async setRead(granted: boolean): Promise<void> {
          const tx = runtime.edit();
          tx.writeOrThrow({
            space: session.space,
            id: `of:${session.space}`,
            type: "application/json",
            path: [],
          }, {
            value: {
              [identity.did()]: "OWNER",
              ...(granted ? { [viewer.did()]: "READ" } : {}),
            },
          });
          expect((await tx.commit()).error).toBeUndefined();
        },
        async [Symbol.asyncDispose]() {
          cancel();
          await runtime[Symbol.asyncDispose]();
        },
      };
    }

    it("shows the owner a PolicyOf note once its manifest arrives", async () => {
      await using view = await renderPolicyNote();
      const before = await view.settle();
      expect(before).toContain("Content hidden by policy");
      expect(before).not.toContain("Policy note");
      await view.installManifest();
      expect(await view.settle()).toContain("Policy note");
    });

    it("shows a delegate the PolicyOf note only while the space's ACL grants it READ", async () => {
      const delegate = await Identity.generate({ implementation: "noble" });
      await using view = await renderPolicyNote(delegate);
      await view.installManifest();
      await view.setRead(false);
      const before = await view.settle();
      expect(before).not.toContain("Policy note");
      await view.setRead(true);
      expect(await view.settle()).toContain("Policy note");
      await view.setRead(false);
      expect(await view.settle()).toContain("Content hidden by policy");
    });

    it("reads the manifest from the linked space the note's label lives in", async () => {
      // The rendered cell is a link, in the session space, to a note stored
      // in another space; the label is read from that space's document, so
      // that is where the manifest has to be, not the session space.
      const identity = await Identity.generate({ implementation: "noble" });
      const other = (await Identity.generate({ implementation: "noble" }))
        .did();
      const session = await createSession({
        identity,
        spaceDid: identity.did(),
      });
      const options = createRuntimeClientOptions({
        session,
        apiUrl: new URL("http://localhost/"),
        cfcRenderCeiling: true,
      });
      await using runtime = createWorkerRuntime(options);

      const seedNote = runtime.edit();
      writeSeedEnvelopeDoc(seedNote, other);
      const note = runtime.getCell<WorkerRenderNode>(
        other,
        "Linked note",
        undefined,
        seedNote,
      );
      seedStoredEnvelope(seedNote, {
        space: other,
        id: note.getAsNormalizedFullLink().id!,
        type: "application/json",
        path: [],
      }, {
        value: "Linked note",
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [cfcAtom.modulePolicyRef(
                  directReleaseManifest.manifest.moduleIdentity,
                  directReleaseManifest.manifest.symbol,
                  directReleaseManifest.policyDigest,
                  other,
                )],
              },
            }],
          },
        },
      });
      expect((await seedNote.commit()).error).toBeUndefined();
      const acl = runtime.edit();
      acl.writeOrThrow({
        space: other,
        id: `of:${other}`,
        type: "application/json",
        path: [],
      }, { value: { [other]: "OWNER", [identity.did()]: "READ" } });
      expect((await acl.commit()).error).toBeUndefined();
      const seedHolder = runtime.edit();
      const holder = runtime.getCell<{ note: unknown }>(
        session.space,
        "Linked note holder",
        undefined,
        seedHolder,
      );
      // Stored raw: a runtime write would carry the note's label into the
      // holder and have the commit install the manifest beside it.
      writeSeedEnvelopeDoc(seedHolder, session.space);
      seedStoredEnvelope(seedHolder, {
        space: session.space,
        id: holder.getAsNormalizedFullLink().id!,
        type: "application/json",
        path: [],
      }, {
        value: { note: note.getAsLink() },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: [] },
        },
      } as never);
      expect((await seedHolder.commit()).error).toBeUndefined();
      const installIn = async (space: string) => {
        const tx = runtime.storageManager.edit();
        tx.write({
          space: space as typeof other,
          id: `of:cfc-policy-manifest:${directReleaseManifest.policyDigest}`,
          type: "application/json",
          path: ["value"],
        }, directReleaseManifest as never);
        expect((await tx.commit()).error).toBeUndefined();
      };

      const ceiling = options.renderConfidentialityCeiling;
      const membership = renderMembershipProviderFor(
        runtime,
        identity,
        ceiling,
      );
      const manifests = renderModulePolicySourceFor(runtime, ceiling);
      const ops: VDomOp[] = [];
      const reconciler = new WorkerReconciler({
        onOps: (batch) => ops.push(...batch),
        renderDeclassificationPolicy: options.renderDeclassificationPolicy,
        renderConfidentialityCeiling: ceiling,
        resolveRenderConfidentiality: renderConfidentialityResolverFor(
          runtime,
          identity,
          ceiling,
          options.spaceDid,
          membership,
          manifests,
        ),
        membershipProvider: membership,
        modulePolicySource: manifests,
      });
      const cancel = reconciler.mount({
        type: "vnode",
        name: "div",
        props: {},
        children: [holder.key("note") as never],
      });
      const settle = async () => {
        await runtime.storageManager.synced();
        await runtime.idle();
        reconciler.flush();
        const text = emittedText(ops);
        ops.length = 0;
        return text;
      };
      try {
        const before = await settle();
        expect(before).toContain("Content hidden by policy");
        expect(before).not.toContain("Linked note");
        // Installed only where the rendered cell lives: still sealed.
        await installIn(session.space);
        expect(await settle()).not.toContain("Linked note");
        // Installed beside the label: released, and re-rendered on arrival.
        await installIn(other);
        expect(await settle()).toContain("Linked note");
      } finally {
        cancel();
      }
    });
  });
});

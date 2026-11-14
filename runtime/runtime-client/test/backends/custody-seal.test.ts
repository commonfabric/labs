import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { ACLManager, type Cell, Runtime } from "@commonfabric/runner";
import {
  buildCfcPolicyArtifactManifest,
  type CfcTrustConfigInput,
} from "@commonfabric/runner/cfc";
import {
  type CustodyAnswerWatchUpdate,
  TRUSTED_DECLASSIFIER_CONCEPT,
} from "@commonfabric/runner/cfc/custody-seal";
import { defaultDisplayCeiling } from "@commonfabric/runner/cfc/default-display-ceiling";
import { rootRenderPolicyFor } from "@commonfabric/html/worker";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { watchCustodyAnswerForHost } from "@/backends/custody-answer-watch.ts";
import { HostReadGate } from "@/backends/host-read-gate.ts";
import {
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  renderModulePolicySourceFor,
  type RuntimeProcessor,
} from "@/backends/runtime-processor.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";
import {
  type CellRef,
  type CustodyAnswerState,
  type CustodySealPreview,
  NotificationType,
  RequestType,
} from "@/protocol/mod.ts";

import { buildProcessor } from "./build-processor.ts";

const alice = await Identity.fromPassphrase("custody seal IPC alice");
const bob = await Identity.fromPassphrase("custody seal IPC bob");
const carol = await Identity.fromPassphrase("custody seal IPC carol");
const roomOwner = await Identity.fromPassphrase("custody seal IPC room");
const S = roomOwner.did();
const first: WorkerClient = { id: 1, post: () => true };
const second: WorkerClient = { id: 2, post: () => true };

const MODULE = "sha256:custody-ipc-module";
const REVIEWER = "did:web:review.example";
const CUSTODY = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: MODULE,
  symbol: "custodyRules",
  template: {
    templateVersion: 1,
    exchangeRules: [],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});
const P = cfcAtom.modulePolicyRef(
  MODULE,
  "custodyRules",
  CUSTODY.policyDigest,
  S,
);

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

const TERMS = {
  question: "Where should we eat?",
  answers: ["pizza", "sushi", "no agreement"],
  seats: [alice.did(), bob.did()],
  stanceSchema: {
    type: "object",
    properties: { choice: { enum: ["pizza", "sushi"] } },
    required: ["choice"],
    additionalProperties: false,
  },
};

const calendar = {
  type: CFC_ATOM_TYPE.Context,
  name: "calendar",
  subject: alice.did(),
};

type Fixture = {
  processor: RuntimeProcessor;
  runtime: Runtime;
  draft: Cell<{ choice: string }>;
  sources: Cell<unknown[]>;
  policy: Cell<unknown>;
  acl: ACLManager;
  refs: {
    draft: CellRef;
    terms: CellRef;
    policy: CellRef;
    allowedSources: CellRef;
  };
};

/**
 * Alice's runtime over a memory server shared with the room's identity: a
 * room space holding terms, the room's installed custody policy, and an
 * access list naming its readers; and in Alice's home space her draft, a
 * cell holding the policy reference, and her source policy.
 */
async function withFixture(
  body: (fixture: Fixture) => Promise<void>,
  {
    sources = [] as unknown[],
    withAcl = true,
    draftLabel = undefined as unknown[] | undefined,
  } = {},
) {
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const managers: EmulatedStorageManager[] = [];
  const runtimeFor = (identity: Identity) => {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: identity,
    });
    managers.push(storageManager);
    return new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcTrustConfig: TRUST,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      trustSnapshotProvider: () => ({
        id: identity.did(),
        actingPrincipal: identity.did(),
      }),
    });
  };
  const runtime = runtimeFor(alice);
  const roomRuntime = runtimeFor(roomOwner);
  runtime.registerCfcPolicyManifests(undefined, [CUSTODY]);
  const processor = buildProcessor({ runtime, identity: alice });
  try {
    const install = runtime.edit();
    // A room document declaring the policy installs its manifest in the room.
    runtime.getCell(S, "custody-room-state", {
      type: "object",
      ifc: { confidentiality: [{ ...P, subject: { __ctOwningSpace: true } }] },
    } as never, install).set({ open: true } as never);
    const terms = runtime.getCell(S, "custody-terms", undefined, install);
    terms.set(TERMS as never);
    expect((await install.commit().settled).error).toBeUndefined();
    const acl = new ACLManager(roomRuntime, S);
    if (withAcl) {
      await acl.set(roomOwner.did(), "OWNER");
      await acl.set(alice.did(), "WRITE");
      await acl.set(bob.did(), "READ");
    }

    const home = alice.did();
    const tx = runtime.edit();
    const draft = runtime.getCell<{ choice: string }>(home, "stance-draft", {
      type: "object",
      properties: { choice: { type: "string" } },
      ifc: { confidentiality: draftLabel ?? [cfcAtom.user(home)] },
    } as never, tx);
    draft.set({ choice: "sushi" });
    const policy = runtime.getCell(home, "room-policy", undefined, tx);
    policy.set(P as never);
    const allowed = runtime.getCell<unknown[]>(home, "custody-sources", {
      ifc: { confidentiality: [cfcAtom.user(home)] },
    } as never, tx);
    allowed.set(sources);
    expect((await tx.commit().settled).error).toBeUndefined();

    await body({
      processor,
      runtime,
      draft: draft.withTx(undefined),
      sources: allowed.withTx(undefined),
      policy: policy.withTx(undefined),
      acl,
      refs: {
        draft: createCellRef(draft),
        terms: createCellRef(terms),
        policy: createCellRef(policy),
        allowedSources: createCellRef(allowed),
      },
    });
  } finally {
    await processor.dispose();
    await roomRuntime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  }
}

/**
 * Runs `step` at a point inside the runtime's `index`th `editWithRetry` call
 * (counting from 0). A seal's commit runs its checks, then writes the anchor
 * (call 0) and, after the receipt, the entry (call 1), so this reaches the
 * commit past every check the worker makes before it. `"before"` runs `step`
 * before the call starts and awaits it, so a rewrite `step` commits first;
 * `"after"` runs it once the call's action has staged its writes and before
 * the transaction commits. The action is synchronous, so an `"after"` step
 * must be too: one that returns a promise throws rather than racing the
 * commit it was meant to precede.
 */
function atEditWithRetry(
  runtime: Runtime,
  index: number,
  when: "before",
  step: () => Promise<void> | void,
): void;
function atEditWithRetry(
  runtime: Runtime,
  index: number,
  when: "after",
  step: () => void,
): void;
function atEditWithRetry(
  runtime: Runtime,
  index: number,
  when: "before" | "after",
  step: () => Promise<void> | void,
) {
  const original = runtime.editWithRetry.bind(runtime);
  let calls = 0;
  runtime.editWithRetry = (async (
    ...[fn, ...rest]: Parameters<Runtime["editWithRetry"]>
  ) => {
    if (calls++ !== index) return await original(fn, ...rest);
    if (when === "before") {
      await step();
      return await original(fn, ...rest);
    }
    return await original((tx) => {
      const staged = fn(tx);
      if (step() instanceof Promise) {
        throw new Error("An after-staging step must be synchronous");
      }
      return staged;
    }, ...rest);
  }) as Runtime["editWithRetry"];
}

/** Replaces a cell's value in its own committed transaction. */
async function rewrite<T>(runtime: Runtime, cell: Cell<T>, value: T) {
  const tx = runtime.edit();
  cell.withTx(tx).set(value);
  expect((await tx.commit().settled).error).toBeUndefined();
}

describe("custody-seal", () => {
  it("seals through the trusted host transport and answers with the actor's receipt", async () => {
    await withFixture(async ({ processor, runtime, refs }) => {
      const preview = await processor.handleRequest({
        type: RequestType.CustodySealPrepare,
        ...refs,
        // A host's schema is view context; it grants the preview nothing.
        terms: { ...refs.terms, schema: { default: { room: "Fake room" } } },
      }, first) as CustodySealPreview;
      expect(Object.keys(preview).sort()).toEqual([
        "actor",
        "heldWith",
        "id",
        "instance",
        "policy",
        "readers",
        "room",
        "sources",
        "stance",
        "terms",
        "witnessedRelease",
      ]);
      expect(preview.actor).toBe(alice.did());
      expect(preview.room).toBe(S);
      // Every principal the room's access list names, the room space's own
      // key among them, ordered by principal.
      expect(preview.readers).toEqual(
        [
          { principal: S, role: "owner" },
          { principal: alice.did(), role: "writer" },
          { principal: bob.did(), role: "reader" },
        ].sort((a, b) => a.principal < b.principal ? -1 : 1),
      );
      expect(preview.terms).toEqual(TERMS);
      expect(preview.policy).toEqual(P);
      expect(preview.stance).toEqual({ choice: "sushi" });
      expect(preview.sources).toEqual([]);
      // The fixture's policy has no rules, so nothing it releases is unwitnessed.
      expect(preview.witnessedRelease).toBe(true);

      const sealed = await processor.handleRequest({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first) as { receipt: CellRef; box: CellRef; instance: string };
      const receipt = runtime.getCellFromLink(sealed.receipt);
      expect(sealed.receipt.space).toBe(alice.did());
      expect(receipt.get()).toMatchObject({
        policy: P,
        instance: preview.instance,
      });
      // The box a pattern's projector reads: the instance's one document in
      // the room space, holding the entry the receipt names.
      expect(sealed.instance).toBe(preview.instance);
      expect(sealed.box.space).toBe(S);
      expect(sealed.box.path).toEqual([]);
      const box = runtime.getCellFromLink(sealed.box);
      expect(Object.keys(box.getRaw() as object)).toEqual([
        (receipt.get() as { entryKey: string }).entryKey,
      ]);
    });
  });

  it("hands the dialog the people a value was drawn from data shared with", async () => {
    const home = alice.did();
    await withFixture(async ({ processor, refs }) => {
      const preview = await processor.handleRequest({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first) as CustodySealPreview;
      expect(preview.heldWith).toEqual([[bob.did()]]);
      expect(preview.sources).toEqual([]);
    }, {
      draftLabel: [
        cfcAtom.user(home),
        { anyOf: [home, cfcAtom.user(bob.did())] },
      ],
    });
  });

  it("writes the link to the box into the room's box cell the host names", async () => {
    await withFixture(async ({ processor, runtime, refs }) => {
      // The room document whose cell receives the link.
      const cells = runtime.getCell(S, "room-cells");
      const setup = runtime.edit();
      cells.withTx(setup).set({} as never);
      expect((await setup.commit().settled).error).toBeUndefined();
      const roomBox = cells.key("box");
      const preview = await processor.handleRequest({
        type: RequestType.CustodySealPrepare,
        ...refs,
        box: createCellRef(roomBox),
      }, first) as CustodySealPreview;
      const sealed = await processor.handleRequest({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first) as { receipt: CellRef; box: CellRef; instance: string };
      await roomBox.sync();
      const tx = runtime.edit();
      const linked = roomBox.withTx(tx).resolveAsCell()
        .getAsNormalizedFullLink();
      tx.abort();
      expect(linked.space).toBe(S);
      expect(linked.id).toBe(sealed.box.id);
    });
  });

  it("refuses a custody answer watch once the worker is disposed", async () => {
    await withFixture(async ({ processor, runtime, refs }) => {
      await processor.dispose();
      expect(() =>
        processor.handleCustodyAnswerWatch({
          type: RequestType.CustodyAnswerWatch,
          watchId: "after-disposal",
          terms: refs.terms,
          policy: refs.policy,
          output: createCellRef(runtime.getCell(S, "custody-room-choice")),
        })
      ).toThrow("Custody sealing is unavailable");
    });
  });

  it("admits one confirmation, from the client that prepared it", async () => {
    await withFixture(async ({ processor, refs }) => {
      await expect(processor.handleRequest({
        type: RequestType.CustodySealCommit,
        id: "fabricated-consent",
      }, first)).rejects.toThrow("Custody seal confirmation is unavailable");
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, second)).rejects.toThrow("Custody seal confirmation is unavailable");
      await processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first);
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow("Custody seal confirmation is unavailable");
    });
  });

  it("refuses a review whose draft changed, and consumes the confirmation", async () => {
    await withFixture(async ({ processor, runtime, draft, refs }) => {
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      await rewrite(runtime, draft, { choice: "pizza" });
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow("review is stale");
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow("Custody seal confirmation is unavailable");
    });
  });

  it("refuses a review whose source policy changed after preparation", async () => {
    await withFixture(async ({ processor, runtime, sources, refs }) => {
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      await rewrite(runtime, sources, []);
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow("review is stale");
    }, { sources: [calendar] });
  });

  it("refuses a seal whose source policy changed after the commit's checks", async () => {
    await withFixture(async ({ processor, runtime, sources, refs }) => {
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      // The policy narrows after every check that precedes the anchor, and
      // before the transaction that writes the entry.
      atEditWithRetry(
        runtime,
        0,
        "before",
        () => rewrite(runtime, sources, []),
      );
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow("review changed before commit");
      // No entry was written, so a fresh review still prepares.
      await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, second);
    }, { sources: [calendar] });
  });

  it("refuses a review whose policy cell changed after preparation", async () => {
    await withFixture(async ({ processor, runtime, policy, refs }) => {
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      await rewrite(runtime, policy, { ...P, symbol: "otherRules" });
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow("review is stale");
    });
  });

  it("refuses a seal whose policy cell changed after the commit's checks", async () => {
    await withFixture(async ({ processor, runtime, policy, refs }) => {
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      atEditWithRetry(
        runtime,
        0,
        "before",
        () => rewrite(runtime, policy, { ...P, symbol: "otherRules" }),
      );
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow("review changed before commit");
      await rewrite(runtime, policy, P);
      await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, second);
    });
  });

  it("refuses a room space with no access list", async () => {
    await withFixture(async ({ processor, refs }) => {
      await expect(processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first)).rejects.toThrow("access list names its readers");
    }, { withAcl: false });
  });

  it("refuses a review whose room readers changed after preparation", async () => {
    await withFixture(async ({ processor, acl, refs }) => {
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      await acl.set(carol.did(), "READ");
      // The commit's own reading finds the new reader when this runtime has
      // received the change by then, and the entry's transaction finds it
      // otherwise; either refuses the review.
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow(
        /review is stale|review changed before commit/,
      );
    });
  });

  it("does not seal for a client that detached once the entry was staged", async () => {
    await withFixture(async ({ processor, runtime, refs }) => {
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      // The client leaves after the anchor and the receipt are written and
      // the entry's transaction has staged its write, before it commits.
      atEditWithRetry(
        runtime,
        1,
        "after",
        () => processor.disposeClient(first),
      );
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow("Custody sealing is unavailable");
      // No entry was written, so a fresh review from another client still
      // prepares.
      await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, second);
    });
  });

  it("does not seal once the worker is disposed while the entry is staged", async () => {
    await withFixture(async ({ processor, runtime, refs }) => {
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      atEditWithRetry(runtime, 1, "after", () => {
        processor.dispose();
      });
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first)).rejects.toThrow("Custody sealing is unavailable");
    });
  });

  it("keeps no review for a client that detached while it was preparing", async () => {
    await withFixture(async ({ processor, refs }) => {
      const preparing = processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      processor.disposeClient(first);
      await expect(preparing).rejects.toThrow(
        "Custody sealing is unavailable",
      );
    });
  });

  it("does not seal for a client that detached while its commit was reading", async () => {
    await withFixture(async ({ processor, refs }) => {
      const preview = await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, first);
      const committing = processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first);
      processor.disposeClient(first);
      await expect(committing).rejects.toThrow(
        "Custody sealing is unavailable",
      );
      // The actor has not sealed, so a fresh review from another client
      // still prepares.
      await processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
      }, second);
    });
  });

  it("refuses a source policy outside the actor's home space", async () => {
    await withFixture(async ({ processor, refs }) => {
      await expect(processor.handleCustodySealPrepare({
        type: RequestType.CustodySealPrepare,
        ...refs,
        allowedSources: refs.terms,
      }, first)).rejects.toThrow("only from the actor's home space");
    });
  });

  it("discards a canceled seal and a departing client's seals, keeping others", async () => {
    await withFixture(async ({ processor, refs }) => {
      const request = {
        type: RequestType.CustodySealPrepare as const,
        ...refs,
      };
      const canceled = await processor.handleCustodySealPrepare(request, first);
      await processor.handleRequest({
        type: RequestType.CustodySealCancel,
        id: canceled.id,
      }, second);
      await processor.handleRequest({
        type: RequestType.CustodySealCancel,
        id: canceled.id,
      }, first);
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: canceled.id,
      }, first)).rejects.toThrow("Custody seal confirmation is unavailable");

      const departing = await processor.handleCustodySealPrepare(
        request,
        first,
      );
      const retained = await processor.handleCustodySealPrepare(
        request,
        second,
      );
      processor.disposeClient(first);
      await expect(processor.handleCustodySealCommit({
        type: RequestType.CustodySealCommit,
        id: departing.id,
      }, first)).rejects.toThrow("Custody seal confirmation is unavailable");
      await expect(processor.handleCustodySealPrepare(request, first))
        .rejects.toThrow("Custody sealing is unavailable");
      expect(
        await processor.handleCustodySealCommit({
          type: RequestType.CustodySealCommit,
          id: retained.id,
        }, second),
      ).toHaveProperty("box");
    });
  });
});

describe("custody answer watch", () => {
  /** The room policy's clause as a pattern's `PolicyOf` cell declares it. */
  const DECLARED = { ...P, subject: { __ctOwningSpace: true } };

  /** Writes `value` into a new room-space cell labeled `confidentiality`. */
  const labeled = async (
    runtime: Runtime,
    id: string,
    value: unknown,
    confidentiality: unknown[],
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(S, id, {
      ifc: { confidentiality },
    } as never, tx);
    cell.set(value as never);
    expect((await tx.commit().settled).error).toBeUndefined();
    return cell.withTx(undefined);
  };

  /**
   * A client that keeps what the worker posts it, and answers the first post
   * from now on that a test admits, resolved by the post itself.
   */
  const recordingClient = (id: number) => {
    const posted: unknown[] = [];
    let waiting:
      | { test: (message: unknown) => boolean; resolve: (m: unknown) => void }
      | undefined;
    const client: WorkerClient = {
      id,
      post: (message) => {
        posted.push(message);
        if (waiting?.test(message)) {
          waiting.resolve(message);
          waiting = undefined;
        }
        return true;
      },
    };
    return {
      client,
      posted,
      until(test: (message: unknown) => boolean): Promise<unknown> {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        waiting = { test, resolve };
        return promise;
      },
    };
  };
  const answerUpdate = (watchId: string) => (message: unknown) =>
    (message as { type?: string }).type ===
      NotificationType.CustodyAnswerUpdate &&
    (message as { watchId?: string }).watchId === watchId;

  it("watches a room whose policy the display ceiling refuses its member, sending what its instance has published", async () => {
    // A pattern's policy cell is labeled with the room's policy, which no
    // display ceiling admits: a member's host is refused it, as it is the
    // projected answer. The watch reads both with the worker's authority, so
    // the host learns what the instance has published all the same.

    await withFixture(async ({ processor, runtime, refs }) => {
      const policy = await labeled(runtime, "declared-policy", true, [
        DECLARED,
      ]);
      processor.accessForTestingOnly.renderConfidentialityCeiling =
        defaultDisplayCeiling(alice.did()) as never;
      const host = recordingClient(7);
      const refusal = host.until((message) =>
        (message as { type?: string }).type === NotificationType.CellUpdate
      );
      processor.handleCellSubscribe({
        type: RequestType.CellSubscribe,
        cell: createCellRef(policy),
      }, host.client);
      expect(await refusal).toMatchObject({
        refused: { refusedBy: "display-ceiling" },
      });

      const update = host.until(answerUpdate("room"));
      await processor.handleRequest({
        type: RequestType.CustodyAnswerWatch,
        watchId: "room",
        terms: refs.terms,
        policy: createCellRef(policy),
        output: createCellRef(runtime.getCell(S, "custody-room-choice")),
      }, host.client);

      // No seat has sealed, so nothing is published, and nothing failed.
      expect(await update).toEqual({
        type: NotificationType.CustodyAnswerUpdate,
        watchId: "room",
        state: { status: "pending" },
      });
    });
  });

  it("starts a watch again under an id it ended, and ends a departing client's watches", async () => {
    await withFixture(async ({ processor, runtime, refs }) => {
      const host = recordingClient(8);
      const watch = (watchId: string) =>
        processor.handleRequest({
          type: RequestType.CustodyAnswerWatch,
          watchId,
          terms: refs.terms,
          policy: refs.policy,
          output: createCellRef(runtime.getCell(S, "custody-room-choice")),
        }, host.client);

      let update = host.until(answerUpdate("room"));
      await watch("room");
      await update;
      await processor.handleRequest({
        type: RequestType.CustodyAnswerUnwatch,
        watchId: "room",
      }, host.client);
      // Ended, the id names no watch, so watching under it starts one.
      update = host.until(answerUpdate("room"));
      await watch("room");
      expect(await update).toMatchObject({ state: { status: "pending" } });

      processor.disposeClient(host.client);
      const posts = host.posted.length;
      // The room's terms become ones the seal refuses, which a standing
      // watch sends its client as an error: another client's watch, started
      // before the change, says when that has happened.
      const other = recordingClient(9);
      let refused = other.until(answerUpdate("other"));
      await processor.handleRequest({
        type: RequestType.CustodyAnswerWatch,
        watchId: "other",
        terms: refs.terms,
        policy: refs.policy,
        output: createCellRef(runtime.getCell(S, "custody-room-choice")),
      }, other.client);
      await refused;
      refused = other.until((message) =>
        answerUpdate("other")(message) &&
        "error" in (message as { state: object }).state
      );
      const tx = runtime.edit();
      runtime.getCellFromLink(refs.terms, undefined, tx).set(
        "not terms" as never,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await refused;
      await runtime.idle();
      expect(host.posted.length).toBe(posts);
      // Detached, the client starts no watch it could not end.
      await expect(watch("late")).rejects.toThrow(
        "Custody sealing is unavailable",
      );
    });
  });

  describe("what the host is sent", () => {
    /**
     * Watches for a host whose gate holds `alice`'s reads to her display
     * ceiling, with a seal's watch that reports what the test sends it.
     */
    const watchFor = (
      runtime: Runtime,
      gateFor: (gate: HostReadGate) => HostReadGate = (gate) => gate,
    ) => {
      const ceiling = defaultDisplayCeiling(alice.did());
      const membership = renderMembershipProviderFor(runtime, alice, ceiling);
      const modulePolicies = renderModulePolicySourceFor(runtime, ceiling);
      const gate = new HostReadGate(rootRenderPolicyFor(ceiling), {
        resolveConfidentiality: renderConfidentialityResolverFor(
          runtime,
          alice,
          ceiling,
          alice.did(),
          membership,
          modulePolicies,
        ),
        membership,
        modulePolicies,
      });
      let report: ((update: CustodyAnswerWatchUpdate) => void) | undefined;
      const sent: CustodyAnswerState[] = [];
      let waiting: ((state: CustodyAnswerState) => void) | undefined;
      const cancel = watchCustodyAnswerForHost(
        gateFor(gate),
        { terms: runtime.getCell(S, "unused-terms"), policy: P },
        runtime.getCell(S, "unused-output"),
        (state) => {
          sent.push(state);
          waiting?.(state);
          waiting = undefined;
        },
        (_room, _output, onUpdate) => {
          report = onUpdate;
          return () => {
            report = undefined;
          };
        },
      );
      return {
        sent,
        cancel,
        /** Reports `update` as the seal's watch would. */
        report: (update: CustodyAnswerWatchUpdate) => report!(update),
        /** The next state the host is sent. */
        next(): Promise<CustodyAnswerState> {
          const { promise, resolve } = Promise.withResolvers<
            CustodyAnswerState
          >();
          waiting = resolve;
          return promise;
        },
      };
    };
    const published = (answer: Cell<unknown>, value: unknown) => ({
      status: "published" as const,
      instance: "instance-digest",
      publishedHere: true,
      answer,
      value: value as never,
    });

    it("sends a published answer the room's readers may see, as the gate reads it", async () => {
      await withFixture(async ({ runtime }) => {
        const slot = await labeled(runtime, "readers-answer", {
          answer: "sushi",
        }, [cfcAtom.space(S)]);
        const host = watchFor(runtime);
        try {
          const state = host.next();
          host.report(published(slot.key("answer"), "sushi"));

          expect(await state).toEqual({
            status: "published",
            instance: "instance-digest",
            publishedHere: true,
            answer: { value: "sushi" },
          });
        } finally {
          host.cancel();
        }
      });
    });

    it("sends the gate's refusal in place of an answer the ceiling does not admit", async () => {
      await withFixture(async ({ runtime }) => {
        const slot = await labeled(runtime, "sealed-answer", {
          answer: "sushi",
        }, [DECLARED]);
        const host = watchFor(runtime);
        try {
          const state = host.next();
          host.report(published(slot.key("answer"), "sushi"));

          expect(await state).toMatchObject({
            status: "published",
            answer: { refused: { refusedBy: "display-ceiling" } },
          });
          expect(JSON.stringify(host.sent)).not.toContain("sushi");
        } finally {
          host.cancel();
        }
      });
    });

    it("sends no answer whose value differs from the one the seal verified", async () => {
      await withFixture(async ({ runtime }) => {
        const slot = await labeled(runtime, "rewritten-answer", {
          answer: "tacos",
        }, [cfcAtom.space(S)]);
        const host = watchFor(runtime);
        try {
          const state = host.next();
          host.report(published(slot.key("answer"), "sushi"));

          expect(await state).toEqual({
            status: "pending",
            error: "Custody answer refuses a slot the seal did not write",
          });
        } finally {
          host.cancel();
        }
      });
    });

    it("sends the answer of another policy's slot for the same instance", async () => {
      // The room's policy cell can name another policy over the same terms:
      // the instance digest is the same, and the slot is another.

      await withFixture(async ({ runtime }) => {
        const first = await labeled(runtime, "first-policy-answer", {
          answer: "sushi",
        }, [cfcAtom.space(S)]);
        const second = await labeled(runtime, "second-policy-answer", {
          answer: "tacos",
        }, [cfcAtom.space(S)]);
        const host = watchFor(runtime);
        try {
          let state = host.next();
          host.report(published(first.key("answer"), "sushi"));
          await state;
          state = host.next();
          host.report(published(second.key("answer"), "tacos"));

          expect(await state).toMatchObject({ answer: { value: "tacos" } });
        } finally {
          host.cancel();
        }
      });
    });

    it("tries a failed decision again on the next report of the same answer", async () => {
      await withFixture(async ({ runtime }) => {
        const slot = await labeled(runtime, "answer-after-failure", {
          answer: "sushi",
        }, [cfcAtom.space(S)]);
        let failures = 1;
        const host = watchFor(runtime, (gate) =>
          ({
            settle: (cell: Cell<unknown>) =>
              failures-- > 0
                ? Promise.reject(new Error("access list unreachable"))
                : gate.settle(cell),
            subscribe: gate.subscribe.bind(gate),
            read: gate.read.bind(gate),
          }) as unknown as HostReadGate);
        try {
          let state = host.next();
          host.report(published(slot.key("answer"), "sushi"));
          expect(await state).toEqual({
            status: "pending",
            error: "access list unreachable",
          });
          state = host.next();
          host.report(published(slot.key("answer"), "sushi"));

          expect(await state).toMatchObject({ answer: { value: "sushi" } });
        } finally {
          host.cancel();
        }
      });
    });

    it("sends each change once, and stops deciding an answer once nothing is published", async () => {
      await withFixture(async ({ runtime }) => {
        const slot = await labeled(runtime, "answer-then-pending", {
          answer: "sushi",
        }, [cfcAtom.space(S)]);
        const host = watchFor(runtime);
        try {
          host.report({ status: "pending" });
          host.report({ status: "pending" });
          const state = host.next();
          host.report(published(slot.key("answer"), "sushi"));
          await state;
          // The same instance again is decided by the subscription standing.
          host.report(published(slot.key("answer"), "sushi"));
          host.report({ status: "pending" });
          // A subscription still standing would decide this write again.
          const tx = runtime.edit();
          slot.withTx(tx).set({ answer: "tacos" } as never);
          expect((await tx.commit().settled).error).toBeUndefined();
          await runtime.idle();

          expect(host.sent.map((sent) => sent.status)).toEqual([
            "pending",
            "published",
            "pending",
          ]);
        } finally {
          host.cancel();
        }
      });
    });
  });
});

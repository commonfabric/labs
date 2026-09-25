import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { ACLManager, type Cell, Runtime } from "@commonfabric/runner";
import {
  buildCfcPolicyArtifactManifest,
  type CfcTrustConfigInput,
} from "@commonfabric/runner/cfc";
import { TRUSTED_DECLASSIFIER_CONCEPT } from "@commonfabric/runner/cfc/custody-seal";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeProcessor } from "@/backends/runtime-processor.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";
import {
  type CellRef,
  type CustodySealPreview,
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
  { sources = [] as unknown[], withAcl = true } = {},
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
    expect((await install.commit()).error).toBeUndefined();
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
      ifc: { confidentiality: [cfcAtom.user(home)] },
    }, tx);
    draft.set({ choice: "sushi" });
    const policy = runtime.getCell(home, "room-policy", undefined, tx);
    policy.set(P as never);
    const allowed = runtime.getCell<unknown[]>(home, "custody-sources", {
      ifc: { confidentiality: [cfcAtom.user(home)] },
    } as never, tx);
    allowed.set(sources);
    expect((await tx.commit()).error).toBeUndefined();

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
  expect((await tx.commit()).error).toBeUndefined();
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
        "id",
        "instance",
        "policy",
        "readers",
        "room",
        "sources",
        "stance",
        "terms",
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

      const sealed = await processor.handleRequest({
        type: RequestType.CustodySealCommit,
        id: preview.id,
      }, first) as { cell: CellRef };
      const receipt = runtime.getCellFromLink(sealed.cell);
      expect(sealed.cell.space).toBe(alice.did());
      expect(receipt.get()).toMatchObject({
        policy: P,
        instance: preview.instance,
      });
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
      ).toHaveProperty("cell");
    });
  });
});

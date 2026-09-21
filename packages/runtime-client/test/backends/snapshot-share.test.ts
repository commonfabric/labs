import type { SnapshotSharePreview } from "../../src/protocol/types.ts";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { RuntimeProcessor } from "@/backends/runtime-processor.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";
import { type CellRef, RequestType } from "@/protocol/mod.ts";

import { buildProcessor } from "./build-processor.ts";

const identity = await Identity.fromPassphrase("snapshot share IPC");
const first: WorkerClient = { id: 1, post: () => true };
const second: WorkerClient = { id: 2, post: () => true };

type Fixture = {
  processor: RuntimeProcessor;
  source: Cell<{ title: string }>;
  sourceRef: CellRef;
  destinationRef: CellRef;
  runtime: Runtime;
};

async function withFixture(body: (fixture: Fixture) => Promise<void>) {
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
    cfcReadMaxConfidentiality: [cfcAtom.user(identity.did())],
    trustSnapshotProvider: () => ({
      id: "snapshot-share-ipc",
      actingPrincipal: identity.did(),
    }),
  });
  const processor = buildProcessor({ runtime, identity });
  try {
    const tx = runtime.edit();
    const source = runtime.getCell<{ title: string }>(
      identity.did(),
      "source",
      {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        ifc: { confidentiality: [cfcAtom.user(identity.did())] },
      },
      tx,
    );
    const destination = runtime.getCell(identity.did(), "destination", {
      type: "object",
    }, tx);
    source.set({ title: "Solaris" });
    destination.set({});
    expect((await tx.commit()).error).toBeUndefined();
    await source.sync();
    await destination.sync();
    await body({
      processor,
      source: source.withTx(undefined),
      sourceRef: createCellRef(source),
      destinationRef: createCellRef(destination),
      runtime,
    });
  } finally {
    await processor.dispose();
    await storageManager.close();
  }
}

describe("snapshot-share", () => {
  it("rejects a prepare request without exactly one audience", async () => {
    await withFixture(async ({ processor, sourceRef, destinationRef }) => {
      for (
        const audience of [null, {}, {
          user: destinationRef,
          space: destinationRef,
        }]
      ) {
        await expect(processor.handleRequest({
          type: RequestType.SnapshotSharePrepare,
          source: sourceRef,
          audience: audience as never,
        })).rejects.toThrow("Snapshot sharing requires one audience");
      }
    });
  });

  it("rejects append targets that are not list bindings before issuing consent", async () => {
    await withFixture(async ({ processor, sourceRef, destinationRef }) => {
      await expect(processor.handleSnapshotSharePrepare({
        type: RequestType.SnapshotSharePrepare,
        source: sourceRef,
        audience: { space: destinationRef },
        appendBooksTo: {
          recommended: sourceRef,
          received: destinationRef,
        },
      })).rejects.toThrow("Snapshot recommendation binding is not a cell link");
    });
  });

  it("rejects a confirmation id without a prepared consent", async () => {
    const processor = buildProcessor();
    await expect(processor.handleRequest({
      type: RequestType.SnapshotShareCommit,
      id: "fabricated-consent",
    })).rejects.toThrow("Snapshot share confirmation is unavailable");
  });

  it("refuses an unbounded prepare before synchronizing either handle", async () => {
    let syncCount = 0;
    const runtime = {
      getCellFromLink: () => ({
        runtime,
        sync: () => {
          syncCount++;
          return Promise.resolve();
        },
      }),
    };
    const processor = buildProcessor({ runtime });
    const ref: CellRef = {
      space: identity.did(),
      id: "of:fid1:unbounded",
      scope: "space",
      path: [],
    };
    await expect(processor.handleSnapshotSharePrepare({
      type: RequestType.SnapshotSharePrepare,
      source: ref,
      audience: { space: ref },
    })).rejects.toThrow(
      "Snapshot sharing requires a bounded runtime read ceiling",
    );
    expect(syncCount).toBe(0);
  });

  it("keeps consent in the backend and admits one confirmation from its client", async () => {
    await withFixture(
      async ({ processor, sourceRef, destinationRef, runtime }) => {
        const preview = await processor.handleRequest({
          type: RequestType.SnapshotSharePrepare,
          source: { ...sourceRef, schema: { default: { title: "forged" } } },
          audience: { space: destinationRef },
        }, first) as SnapshotSharePreview;
        expect(Object.keys(preview).sort()).toEqual([
          "audience",
          "id",
          "value",
        ]);
        expect(preview.value).toEqual({ title: "Solaris" });
        expect(preview.audience).toEqual(cfcAtom.space(identity.did()));
        await expect(processor.handleSnapshotShareCommit({
          type: RequestType.SnapshotShareCommit,
          id: preview.id,
        }, second)).rejects.toThrow(
          "Snapshot share confirmation is unavailable",
        );
        const shared = await processor.handleSnapshotShareCommit({
          type: RequestType.SnapshotShareCommit,
          id: preview.id,
        }, first);
        expect(runtime.getCellFromLink(shared.cell).get()).toEqual({
          title: "Solaris",
        });
        await expect(processor.handleSnapshotShareCommit({
          type: RequestType.SnapshotShareCommit,
          id: preview.id,
        }, first)).rejects.toThrow(
          "Snapshot share confirmation is unavailable",
        );
      },
    );
  });

  it("invalidates a changed preview and consumes the failed confirmation", async () => {
    await withFixture(
      async ({ processor, source, sourceRef, destinationRef, runtime }) => {
        const preview = await processor.handleSnapshotSharePrepare({
          type: RequestType.SnapshotSharePrepare,
          source: sourceRef,
          audience: { space: destinationRef },
        }, first);
        const tx = runtime.edit();
        source.withTx(tx).set({ title: "Roadside Picnic" });
        expect((await tx.commit()).error).toBeUndefined();
        await expect(processor.handleSnapshotShareCommit({
          type: RequestType.SnapshotShareCommit,
          id: preview.id,
        }, first)).rejects.toThrow("Snapshot review is stale");
        await expect(processor.handleSnapshotShareCommit({
          type: RequestType.SnapshotShareCommit,
          id: preview.id,
        }, first)).rejects.toThrow(
          "Snapshot share confirmation is unavailable",
        );
      },
    );
  });

  it("discards only the departing client's prepared snapshots", async () => {
    await withFixture(async ({ processor, sourceRef, destinationRef }) => {
      const request = {
        type: RequestType.SnapshotSharePrepare as const,
        source: sourceRef,
        audience: { space: destinationRef },
      };
      const departing = await processor.handleSnapshotSharePrepare(
        request,
        first,
      );
      const retained = await processor.handleSnapshotSharePrepare(
        request,
        second,
      );
      processor.disposeClient(first);
      await expect(processor.handleSnapshotShareCommit({
        type: RequestType.SnapshotShareCommit,
        id: departing.id,
      }, first)).rejects.toThrow("Snapshot share confirmation is unavailable");
      await expect(processor.handleSnapshotSharePrepare(request, first))
        .rejects.toThrow("Snapshot sharing is unavailable");
      expect(
        await processor.handleSnapshotShareCommit({
          type: RequestType.SnapshotShareCommit,
          id: retained.id,
        }, second),
      ).toHaveProperty("cell");
    });
  });
  it("does not retain a preview when its client detaches during synchronization", async () => {
    const synchronized = Promise.withResolvers<void>();
    const runtime = {
      cfcReadMaxConfidentiality: [],
      getCellFromLink: () => ({ runtime, sync: () => synchronized.promise }),
    };
    const processor = buildProcessor({ runtime });
    const ref: CellRef = {
      space: identity.did(),
      id: "of:fid1:pending",
      scope: "space",
      path: [],
    };
    const pending = processor.handleSnapshotSharePrepare({
      type: RequestType.SnapshotSharePrepare,
      source: ref,
      audience: { space: ref },
    }, first);
    processor.disposeClient(first);
    synchronized.resolve();
    await expect(pending).rejects.toThrow("Snapshot sharing is unavailable");
  });

  it("discards pending consent when the backend is disposed", async () => {
    await withFixture(async ({ processor, sourceRef, destinationRef }) => {
      const preview = await processor.handleSnapshotSharePrepare({
        type: RequestType.SnapshotSharePrepare,
        source: sourceRef,
        audience: { space: destinationRef },
      }, first);
      await processor.dispose();
      await expect(processor.handleSnapshotShareCommit({
        type: RequestType.SnapshotShareCommit,
        id: preview.id,
      }, first)).rejects.toThrow("Snapshot share confirmation is unavailable");
    });
  });
  it("cancels one prepared snapshot without consuming another client's consent", async () => {
    await withFixture(async ({ processor, sourceRef, destinationRef }) => {
      const request = {
        type: RequestType.SnapshotSharePrepare as const,
        source: sourceRef,
        audience: { space: destinationRef },
      };
      const preview = await processor.handleSnapshotSharePrepare(
        request,
        first,
      );
      await processor.handleRequest({
        type: RequestType.SnapshotShareCancel,
        id: preview.id,
      }, second);
      expect(
        await processor.handleSnapshotShareCommit({
          type: RequestType.SnapshotShareCommit,
          id: preview.id,
        }, first),
      ).toHaveProperty("cell");
      const cancelled = await processor.handleSnapshotSharePrepare(
        request,
        first,
      );
      const other = await processor.handleSnapshotSharePrepare(request, first);
      await processor.handleRequest({
        type: RequestType.SnapshotShareCancel,
        id: cancelled.id,
      }, first);
      await expect(processor.handleSnapshotShareCommit({
        type: RequestType.SnapshotShareCommit,
        id: cancelled.id,
      }, first)).rejects.toThrow("Snapshot share confirmation is unavailable");
      expect(
        await processor.handleSnapshotShareCommit({
          type: RequestType.SnapshotShareCommit,
          id: other.id,
        }, first),
      ).toHaveProperty("cell");
    });
  });
});

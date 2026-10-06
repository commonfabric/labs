/**
 * End-to-end storage test for computed-cell id minting
 * (docs/specs/computed-cell-identity.md): a default-on pattern instantiation
 * mints a derived internal cell under the `computed:` URI scheme, and the
 * doc flows through the real memory-v2 server (emulated storage manager)
 * with no special routing.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { Server as MemoryV2Server } from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createRef } from "../src/create-ref.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { toURI } from "../src/uri-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { testSessionOpenAuthFactory } from "./memory-v2-test-utils.ts";

/**
 * End-to-end proof that a default-on pattern instantiation mints a derived
 * internal cell with a `computed:fid1:` id and that the doc flows through
 * storage WITHOUT any special routing: it commits, syncs to the memory-v2
 * server, and reads back through a completely independent session exactly
 * like any ordinary stored document.
 */
const e2eSigner = await Identity.fromPassphrase("computed-id-e2e");

const e2eSpace = e2eSigner.did();

describe("computed-cell id end-to-end (default-on instantiation)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let remoteClient: MemoryV2Client.Client;
  let remoteSession: MemoryV2Client.SpaceSession;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: e2eSigner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const candidate = storageManager as unknown as {
      server?: () => MemoryV2Server;
    };
    if (typeof candidate.server !== "function") {
      throw new Error("Expected a memory/v2 emulated storage manager");
    }
    remoteClient = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(candidate.server()),
    });
    remoteSession = await remoteClient.mount(
      e2eSpace,
      {},
      testSessionOpenAuthFactory,
    );
  });

  afterEach(async () => {
    await runtime.dispose();
    await remoteClient.close();
    await storageManager.close();
    await clock.settle();
  });

  it("stores and syncs a computed:fid1: doc as an ordinary document", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric;

    const double = lift((x: number) => x * 2);
    const doubler = pattern<{ x: number }>(({ x }) => ({
      doubled: double(x),
    }));

    // Flag-on classification tagged the derivation at build time.
    const descriptor = doubler.derivedInternalCells?.find(
      (candidate) => candidate.partialCause === "doubled",
    );
    expect(descriptor?.kind).toBe("computed");

    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ doubled?: number }>(
      e2eSpace,
      "computed-id-e2e",
      undefined,
      tx,
    );
    const result = runtime.run(tx, doubler, { x: 2 }, resultCell);
    runtime.prepareTxForCommit(tx);
    const committed = await tx.commit().settled;
    expect(committed.error).toBeUndefined();
    await runtime.idle();
    await runtime.storageManager.synced();

    // The derived internal cell's identity carries the computed scheme.
    const link = getDerivedInternalCellLink(resultCell, descriptor!);
    expect(link.id.startsWith("computed:fid1:")).toBe(true);

    // The derivation ran and the result reads back locally.
    await result.pull();
    expect(result.key("doubled").get()).toBe(4);

    // Storage no-special-routing proof: a completely independent memory-v2
    // session reads the computed doc back like any ordinary stored document.
    const queried = await remoteSession.queryGraph({
      roots: [{ id: link.id, selector: { path: [], schema: false } }],
    });
    const entity = queried.entities.find((candidate) =>
      candidate.id === link.id
    );
    expect(entity?.document?.value).toBe(4);
  });

  it("keeps strict conflict semantics for stale writes to computed: targets", async () => {
    // Minting is the ONLY behavior this branch changes: a stale commit
    // targeting a computed:-schemed entity conflicts exactly like any other
    // stale commit. The relaxed ack-and-drop policy ships separately behind
    // its own computedDropPolicy flag (see the spec's phased plan).
    const input = runtime.getCell<number>(e2eSpace, "strict-computed-input");
    const computedLink = {
      space: e2eSpace,
      id: toURI(createRef({}, "strict-computed-out"), "computed"),
      path: [],
      scope: "space",
    } as const;
    expect(computedLink.id.startsWith("computed:fid1:")).toBe(true);
    const out = runtime.getCellFromLink<number>(computedLink);

    // Seed the input and let it reach the server.
    const seedTx = runtime.edit();
    input.withTx(seedTx).set(1);
    const seedResult = await seedTx.commit().settled;
    expect(seedResult.error).toBeUndefined();
    await runtime.storageManager.synced();

    // Open the computing transaction and capture its read of the input
    // BEFORE a remote write advances it: the commit's confirmed read is now
    // pinned to the old seq.
    const computeTx = runtime.edit();
    const seen = input.withTx(computeTx).get();
    expect(seen).toBe(1);

    await remoteSession.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.getAsNormalizedFullLink().id,
        value: { value: 5 },
      }],
    });

    // The stale computed-target write is REJECTED, not acknowledged-and-
    // dropped: strict conflict semantics apply until the drop policy's own
    // flag exists and is enabled.
    out.withTx(computeTx).set(seen * 2);
    const result = await computeTx.commit().settled;
    expect(result.error).toBeDefined();
    expect((result.error as { name?: string }).name).toBe("ConflictError");
  });
});

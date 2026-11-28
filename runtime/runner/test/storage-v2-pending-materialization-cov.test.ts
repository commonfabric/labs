/**
 * What a replica's view of a document over its pending layers keeps when a
 * layer goes: the views beneath the dropped layer keep the documents they
 * hold, and every view above it replays.
 */

import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type {
  MemorySpace,
  SealedCommitVerdict,
  URI,
} from "../src/storage/interface.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import {
  mountOver,
  newSharedServer,
  newSpaceReplica,
} from "./memory-v2-test-utils.ts";

const service = await Identity.fromPassphrase(
  "storage-v2 pending materialization service",
);
const space: MemorySpace = (await Identity.fromPassphrase(
  "storage-v2 pending materialization space",
)).did();
const doc = "of:storage-v2-pending-materialization" as URI;

describe("storage/v2 pending materialization", () => {
  let server: MemoryV2Server.Server;
  let replica: SpaceReplica;
  let cleanups: (() => Promise<void> | void)[];

  beforeEach(() => {
    cleanups = [];
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    replica = newSpaceReplica({
      as: service,
      space,
      createSession: async () => {
        const opened = await mountOver(
          MemoryV2Client.loopback(server),
          space,
          service,
        );
        cleanups.push(() => opened.client.close());
        return opened;
      },
    });
    cleanups.push(() => replica.closeNow());
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      removes: [],
      upserts: [{
        id: doc,
        branch: "",
        seq: 1,
        doc: { value: { a: 0, b: 0 } },
      }],
    }, "pull");
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /**
   * Seals a patch replacing `key` with `n` over `value`, the document the
   * writer saw, under a verdict the case decides.
   */
  const sealPatch = (
    key: "a" | "b",
    n: number,
    value: Record<string, FabricValue>,
  ) => {
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const sealed = replica.sealNative(
      {
        operations: [{
          op: "patch",
          id: doc,
          type: "application/json",
          patches: [{ op: "replace", path: `/value/${key}`, value: n }],
          value: { value: { ...value, [key]: n } },
        }],
      },
      undefined,
      verdict.promise,
    );
    const withdraw = async () => {
      verdict.resolve({ withdrawn: { message: "withdrawn by the case" } });
      await sealed.settled;
    };
    cleanups.push(withdraw);
    return { withdraw };
  };

  it("keeps the document a lower layer's view holds when the layer above it is withdrawn", async () => {
    sealPatch("a", 1, { a: 0, b: 0 });
    const lower = replica.getDocument(doc);
    const upper = sealPatch("b", 2, { a: 1, b: 0 });
    expect(replica.getDocument(doc)).toEqual({ value: { a: 1, b: 2 } });

    await upper.withdraw();

    expect(replica.getDocument(doc)).toEqual({ value: { a: 1, b: 0 } });
    expect(replica.getDocument(doc)).toBe(lower);
  });

  it("replays the layer above a withdrawn one over the confirmed document", async () => {
    const lowerLayer = sealPatch("a", 1, { a: 0, b: 0 });
    sealPatch("b", 2, { a: 1, b: 0 });
    const both = replica.getDocument(doc);
    expect(both).toEqual({ value: { a: 1, b: 2 } });

    await lowerLayer.withdraw();

    expect(replica.getDocument(doc)).toEqual({ value: { a: 0, b: 2 } });
  });
});

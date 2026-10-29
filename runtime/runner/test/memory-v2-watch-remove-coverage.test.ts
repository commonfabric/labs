/**
 * The `removes` arm of `SpaceReplica.#applySessionSync()`. A watch refresh
 * batch carries removals when a watched doc is deleted upstream, and the
 * scripted transport here answers the watch add with a sync that upserts
 * two docs and removes one of them in the same batch, so the removes loop
 * runs while `provider.sync()` is awaited, on every run.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  type SessionSync,
  type SessionSyncUpsert,
} from "@commonfabric/memory/v2";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { IStorageProvider } from "../src/storage/interface.ts";
import {
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-watch-remove-coverage");
const space = signer.did();

type TestProvider = IStorageProvider & {
  get(uri: URI): EntityDocument | undefined;
  sync(
    uri: URI,
    selector?: { path: string[]; schema: unknown },
  ): Promise<unknown>;
};

const doc = (
  id: URI,
  seq: number,
  doc: SessionSyncUpsert["doc"],
): SessionSyncUpsert => ({
  branch: "",
  id,
  seq,
  doc,
});

const getObjectValue = (
  provider: TestProvider,
  uri: URI,
): Record<string, unknown> | undefined => {
  const value = provider.get(uri)?.value;
  return isObjectNotArray(value) ? value as Record<string, unknown> : undefined;
};

// Answers the watch.add with a sync that upserts every requested root and then
// removes `removedId` in the same batch, simulating a watched doc deleted
// upstream as the watch is established.
class WatchAddRemoveTransport extends ScriptedSessionTransport {
  readonly #removedId: URI;

  constructor(removedId: URI) {
    super({
      name: "watch-remove-coverage",
      sessionId: "session:watch-remove-coverage",
      space,
    });
    this.#removedId = removedId;
  }

  protected override ackServerSeq(): number {
    return 5;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    switch (message.type) {
      case "session.watch.add": {
        const roots =
          message.watches?.flatMap((watch) =>
            watch.query?.roots?.map((root) => root.id as URI) ?? []
          ) ?? [];
        const toSeq = roots.length + 1;
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: toSeq,
            sync: {
              type: "sync",
              fromSeq: 0,
              toSeq,
              upserts: roots.map((id, index) =>
                doc(id, index + 1, { value: { label: id } })
              ),
              removes: [{ branch: "", id: this.#removedId }],
            } satisfies SessionSync,
          },
        });
        return;
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }
}

describe("memory-v2-watch-remove-coverage", () => {
  it("applies the removes carried in a watch refresh batch", async () => {
    const docA = `of:watch-remove-keep-${crypto.randomUUID()}` as URI;
    const docB = `of:watch-remove-drop-${crypto.randomUUID()}` as URI;
    const transport = new WatchAddRemoveTransport(docB);
    const sessionFactory = new SingleSessionFactory(transport);
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-watch-remove-coverage"),
    }, sessionFactory);
    const provider = storageManager.open(space) as TestProvider;

    try {
      await Promise.all([
        provider.sync(docA, { path: [], schema: false }),
        provider.sync(docB, { path: [], schema: false }),
      ]);

      // docA was upserted and kept; docB was upserted in the same sync and then
      // removed, so the removes loop must have reset it back to absent.
      expect(getObjectValue(provider, docA)).toEqual({ label: docA });
      expect(provider.get(docB)).toBeUndefined();
    } finally {
      await storageManager.close();
    }
  });
});

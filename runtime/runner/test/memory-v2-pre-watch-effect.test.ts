/**
 * Pins delivery of a session effect that arrives before the first watch
 * response. The scripted transport exercises the memory client wire boundary,
 * the watch view, and the runner replica's schema-document arrival validator.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchemaObj } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  type SessionSync,
  type SessionSyncUpsert,
  type WatchSpec,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { IStorageProvider } from "../src/storage/interface.ts";
import {
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  testSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

type TestProvider = IStorageProvider & {
  get(uri: URI): EntityDocument | undefined;
};

const upsert = (
  id: URI,
  seq: number,
  document: SessionSyncUpsert["doc"],
): SessionSyncUpsert => ({
  branch: "",
  id,
  seq,
  doc: document,
});

const sync = (
  fromSeq: number,
  toSeq: number,
  upserts: SessionSyncUpsert[],
): SessionSync => ({
  type: "sync",
  fromSeq,
  toSeq,
  upserts,
  removes: [],
});

class PreWatchEffectTransport extends ScriptedSessionTransport {
  watchResponseSent = false;
  effectSentBeforeWatchResponse = false;

  readonly #schemaId: URI;
  readonly #schema: JSONSchemaObj;
  readonly #referrerId: URI;

  constructor(
    space: MemorySpace,
    schemaId: URI,
    schema: JSONSchemaObj,
    referrerId: URI,
  ) {
    super({
      name: "pre-watch-effect",
      sessionId: "session:pre-watch-effect",
      space,
    });
    this.#schemaId = schemaId;
    this.#schema = schema;
    this.#referrerId = referrerId;
  }

  protected override ackServerSeq(): number {
    return 2;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    if (message.type !== "session.watch.add") {
      throw new Error(`Unhandled scripted message: ${message.type}`);
    }

    this.effectSentBeforeWatchResponse = !this.watchResponseSent;
    this.emitSync(sync(0, 1, [
      upsert(this.#schemaId, 1, { value: this.#schema }),
    ]));

    this.watchResponseSent = true;
    this.respond({
      type: "response",
      requestId: message.requestId!,
      ok: {
        serverSeq: 2,
        sync: sync(1, 2, [
          upsert(this.#referrerId, 2, {
            value: {
              carried: {
                "/": {
                  "link@1": {
                    id: "of:pre-watch-effect-target",
                    path: [],
                    schema: { $ref: this.#schemaId },
                  },
                },
              },
            },
          }),
        ]),
      },
    });
  }
}

class ReplacingPreWatchEffectTransport extends ScriptedSessionTransport {
  watchAddCount = 0;

  readonly #schemaId: URI;
  readonly #schema: JSONSchemaObj;

  constructor(
    space: MemorySpace,
    schemaId: URI,
    schema: JSONSchemaObj,
  ) {
    super({
      name: "replacing-pre-watch-effect",
      sessionId: "session:replacing-pre-watch-effect",
      space,
    });
    this.#schemaId = schemaId;
    this.#schema = schema;
  }

  protected override ackServerSeq(): number {
    return 2;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    if (message.type !== "session.watch.add") {
      throw new Error(`Unhandled scripted message: ${message.type}`);
    }

    this.watchAddCount += 1;
    if (this.watchAddCount === 1) {
      this.emitSync(sync(0, 1, [
        upsert(this.#schemaId, 1, { value: this.#schema }),
      ]));
      this.disconnect(new Error("scripted session replacement"));
      return;
    }

    this.respond({
      type: "response",
      requestId: message.requestId!,
      ok: {
        serverSeq: 2,
        sync: sync(1, 2, []),
      },
    });
  }
}

const watch = (id: URI): WatchSpec => ({
  id,
  kind: "graph",
  query: {
    roots: [{
      id,
      selector: { path: [], schema: false },
    }],
  },
});

describe("memory-v2-pre-watch-effect", () => {
  it("stores a schema effect received before the first watch response", async () => {
    const signer = await Identity.fromPassphrase("memory-v2-pre-watch-effect");
    const space = signer.did();
    const schema: JSONSchemaObj = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };
    const schemaHash = internSchemaAsTaggedHashString(schema);
    const schemaId = `cid:${schemaHash}` as URI;
    const referrerId = "of:pre-watch-effect-referrer" as URI;
    const transport = new PreWatchEffectTransport(
      space,
      schemaId,
      schema,
      referrerId,
    );
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-pre-watch-effect"),
    }, new SingleSessionFactory(transport));
    const provider = storageManager.open(space) as TestProvider;

    try {
      const result = await provider.sync(referrerId, {
        path: [],
        schema: false,
      });

      expect(result.error).toBeUndefined();
      expect(transport.effectSentBeforeWatchResponse).toBe(true);
      expect(provider.get(schemaId)?.value).toEqual(schema);
      expect(provider.get(referrerId)?.value).toBeDefined();
    } finally {
      await storageManager.close();
    }
  });

  it("discards a pre-watch effect when reconnect replaces the session", async () => {
    const signer = await Identity.fromPassphrase(
      "memory-v2-replaced-pre-watch-effect",
    );
    const space = signer.did();
    const schema: JSONSchemaObj = { type: "string" };
    const schemaId = `cid:${internSchemaAsTaggedHashString(schema)}` as URI;
    const watchedId = "of:replaced-pre-watch-effect" as URI;
    const transport = new ReplacingPreWatchEffectTransport(
      space,
      schemaId,
      schema,
    );
    const client = await MemoryV2Client.Client.connect({ transport });
    const session = await client.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      // The connection drops under the first request, which the restore
      // sends again on the session that replaces the one the effect came on.
      const result = await session.watchAddSync([watch(watchedId)]);

      expect(transport.watchAddCount).toBe(2);
      expect(result.precedingSyncs).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

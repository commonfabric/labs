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
import { getLoggerCountsByKey } from "@commonfabric/logger";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type {
  EntityDocument,
  SessionSync,
  SessionSyncUpsert,
  WatchSpec,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import type { IStorageProvider } from "../src/storage/interface.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
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
    if (message.type === "session.watch.set") {
      // The restore re-establishes the watch set the session holds, which
      // the failed add is not part of.
      this.respond({
        type: "response",
        requestId: message.requestId!,
        ok: { serverSeq: 1, sync: sync(1, 1, []) },
      });
      return;
    }
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

/**
 * Answers a `session.watch.set` with an effect ahead of its response, and
 * pushes further effects when told to.
 */
class FirstWatchSetTransport extends ScriptedSessionTransport {
  readonly #ahead: SessionSync;
  readonly #response: SessionSync;

  constructor(space: MemorySpace, ahead: SessionSync, response: SessionSync) {
    super({
      name: "first-watch-set",
      sessionId: "session:first-watch-set",
      space,
    });
    this.#ahead = ahead;
    this.#response = response;
  }

  /** Pushes `effect` to the session. */
  push(effect: SessionSync): void {
    this.emitSync(effect);
  }

  protected override ackServerSeq(): number {
    return this.#response.toSeq;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    if (message.type !== "session.watch.set") {
      throw new Error(`Unhandled scripted message: ${message.type}`);
    }
    this.emitSync(this.#ahead);
    this.respond({
      type: "response",
      requestId: message.requestId!,
      ok: { serverSeq: this.#response.toSeq, sync: this.#response },
    });
  }
}

/**
 * A scripted answer to a watch request: an effect pushed just `ahead` of the
 * response, the response, and an `effect` pushed just after it. An answer
 * that `loses` the connection drops it once they are sent, before the
 * request's send has settled: the response has arrived, so it answers the
 * request all the same. An answer that `holds` its send leaves it unsettled
 * until the connection is lost.
 */
type ScriptedAnswer = {
  ahead?: SessionSync;
  response: SessionSync;
  effect?: SessionSync;
  loses?: boolean;
  holds?: boolean;
};

/**
 * Answers each watch request (`session.watch.add` or `session.watch.set`)
 * with the next of `answers`, pushing its effects around the response at
 * once, so that the client receives them in one microtask cascade, as a
 * socket's transport hands over frames that arrive while an earlier one is
 * being decompressed.
 */
class EffectBehindWatchResponseTransport extends ScriptedSessionTransport {
  /** The watch requests received, by type, in order. */
  readonly requests: string[] = [];

  /**
   * What the response to a reopening of the session adds, as
   * `ScriptedSessionTransport.sessionOpened()` describes; by default the
   * reopening replaces the session.
   */
  reopened: { resumed?: true; sync?: SessionSync } = {};

  readonly #answers: ScriptedAnswer[];

  /** The sends answers held, which settle when the connection is lost. */
  #heldSends: PromiseWithResolvers<void>[] = [];

  #serverSeq = 0;

  constructor(space: MemorySpace, answers: ScriptedAnswer[]) {
    super({
      name: "effect-behind-watch-response",
      sessionId: "session:effect-behind-watch-response",
      space,
    });
    this.#answers = answers;
  }

  /** Drops the connection, as a server that went away does. */
  drop(): void {
    this.disconnect(new Error("scripted connection drop"));
  }

  protected override ackServerSeq(): number {
    return this.#serverSeq;
  }

  protected override sessionOpened(
    openCount: number,
  ): { resumed?: true; sync?: SessionSync } {
    return openCount > 1 ? this.reopened : {};
  }

  protected override handle(
    message: ScriptedTransportMessage,
  ): void | Promise<void> {
    if (
      message.type !== "session.watch.add" &&
      message.type !== "session.watch.set"
    ) {
      throw new Error(`Unhandled scripted message: ${message.type}`);
    }
    this.requests.push(message.type);
    const answer = this.#answers.shift();
    if (answer === undefined) {
      throw new Error(`No scripted answer for ${message.type}`);
    }
    this.#serverSeq = answer.effect?.toSeq ?? answer.response.toSeq;
    if (answer.ahead !== undefined) this.emitSync(answer.ahead);
    this.respond({
      type: "response",
      requestId: message.requestId!,
      ok: { serverSeq: answer.response.toSeq, sync: answer.response },
    });
    if (answer.effect !== undefined) this.emitSync(answer.effect);
    if (answer.loses === true) {
      const lost = MemoryV2Client.connectionError("scripted connection loss");
      for (const held of this.#heldSends.splice(0)) held.reject(lost);
      this.disconnect(lost);
      throw lost;
    }
    if (answer.holds === true) {
      const held = Promise.withResolvers<void>();
      this.#heldSends.push(held);
      return held.promise;
    }
  }
}

/** How many schema-document quarantines this process has logged. */
const quarantines = (): number =>
  getLoggerCountsByKey()["storage.v2"]?.["schema-doc-quarantine"]?.error ?? 0;

/** The `toSeq` and the upserts' values of each of `frames`. */
const framesOf = (frames: readonly SessionSync[]) =>
  frames.map((frame) => ({
    toSeq: frame.toSeq,
    values: frame.upserts.map((upsert) => upsert.doc?.value),
  }));

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

  it("stores an effect's document whose schema the watch response just ahead of it carried", async () => {
    // A transport hands frames that arrive back to back to the client in one
    // microtask cascade, as a socket's does when an earlier frame is still
    // being decompressed. The response still precedes the effect.

    const signer = await Identity.fromPassphrase(
      "memory-v2-effect-behind-watch-response",
    );
    const space = signer.did();
    const schema: JSONSchemaObj = {
      type: "string",
      title: "effect-behind-watch-response",
    };
    const schemaId = `cid:${internSchemaAsTaggedHashString(schema)}` as URI;
    const firstId = "of:effect-behind-watch-response-first" as URI;
    const secondId = "of:effect-behind-watch-response-second" as URI;
    const referrerId = "of:effect-behind-watch-response-referrer" as URI;
    const referrer = {
      value: {
        carried: {
          "/": {
            "link@1": {
              id: "of:effect-behind-watch-response-target",
              path: [],
              schema: { $ref: schemaId },
            },
          },
        },
      },
    };
    const transport = new EffectBehindWatchResponseTransport(space, [
      { response: sync(0, 1, []) },
      {
        response: sync(1, 2, [upsert(schemaId, 2, { value: schema })]),
        effect: sync(2, 3, [upsert(referrerId, 3, referrer)]),
      },
    ]);
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-effect-behind-watch-response"),
    }, new SingleSessionFactory(transport));
    const provider = storageManager.open(space) as TestProvider;
    const replica = provider.replica as SpaceReplica;
    const quarantinesBefore = quarantines();

    try {
      const selector = { path: [], schema: false } as const;
      expect((await provider.sync(firstId, selector)).error).toBeUndefined();
      expect((await provider.sync(secondId, selector)).error)
        .toBeUndefined();
      await replica.framesApplied();

      expect(quarantines()).toBe(quarantinesBefore);
      expect(transport.requests).toEqual([
        "session.watch.add",
        "session.watch.add",
      ]);
      expect(provider.get(schemaId)?.value).toEqual(schema);
      expect(provider.get(referrerId)).toEqual(referrer);
    } finally {
      await storageManager.close();
    }
  });

  it("emits a watch response ahead of the effect that arrived just after it", async () => {
    const signer = await Identity.fromPassphrase(
      "memory-v2-watch-add-effect-order",
    );
    const space = signer.did();
    const documentId = "of:watch-add-effect-order" as URI;
    const transport = new EffectBehindWatchResponseTransport(space, [
      { response: sync(0, 1, []) },
      {
        response: sync(1, 2, [upsert(documentId, 2, { value: "response" })]),
        effect: sync(2, 3, [upsert(documentId, 3, { value: "effect" })]),
      },
    ]);
    const client = await MemoryV2Client.Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport,
    });
    const session = await client.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      const view = await session.watchAdd([watch("of:watch-add-first")]);
      const frames = view.subscribeSync();
      await session.watchAdd([watch(documentId)]);
      const emitted = [
        (await frames.next()).value,
        (await frames.next()).value,
      ];

      expect(framesOf(emitted)).toEqual([
        { toSeq: 2, values: ["response"] },
        { toSeq: 3, values: ["effect"] },
      ]);
      expect(view.snapshot().entities.map((entity) => entity.document))
        .toEqual([{ value: "effect" }]);
    } finally {
      await client.close();
    }
  });

  it("emits an effect that arrived just ahead of a watch response ahead of it", async () => {
    const signer = await Identity.fromPassphrase(
      "memory-v2-effect-ahead-of-watch-response",
    );
    const space = signer.did();
    const documentId = "of:effect-ahead-of-watch-response" as URI;
    const transport = new EffectBehindWatchResponseTransport(space, [
      { response: sync(0, 1, []) },
      {
        ahead: sync(1, 2, [upsert(documentId, 2, { value: "effect" })]),
        response: sync(2, 3, [upsert(documentId, 3, { value: "response" })]),
      },
    ]);
    const client = await MemoryV2Client.Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport,
    });
    const session = await client.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      const view = await session.watchAdd([watch("of:effect-ahead-first")]);
      const frames = view.subscribeSync();
      await session.watchAdd([watch(documentId)]);
      const emitted = [
        (await frames.next()).value,
        (await frames.next()).value,
      ];

      expect(framesOf(emitted)).toEqual([
        { toSeq: 2, values: ["effect"] },
        { toSeq: 3, values: ["response"] },
      ]);
      expect(view.snapshot().entities.map((entity) => entity.document))
        .toEqual([{ value: "response" }]);
    } finally {
      await client.close();
    }
  });

  it("emits an effect behind overlapping watch responses after the one ahead of it", async () => {
    const signer = await Identity.fromPassphrase(
      "memory-v2-effect-behind-overlapping-watch-responses",
    );
    const space = signer.did();
    const firstId = "of:overlapping-first" as URI;
    const secondId = "of:overlapping-second" as URI;
    const transport = new EffectBehindWatchResponseTransport(space, [
      { response: sync(0, 1, []) },
      { response: sync(1, 2, [upsert(firstId, 2, { value: "first" })]) },
      {
        response: sync(2, 3, [upsert(secondId, 3, { value: "second" })]),
        effect: sync(3, 4, [upsert(secondId, 4, { value: "effect" })]),
      },
    ]);
    const client = await MemoryV2Client.Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport,
    });
    const session = await client.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    session.setConcurrentWatchRefresh(true);

    try {
      const view = await session.watchAdd([watch("of:overlapping-root")]);
      const frames = view.subscribeSync();
      await Promise.all([
        session.watchAdd([watch(firstId)]),
        session.watchAdd([watch(secondId)]),
      ]);
      const emitted = [
        (await frames.next()).value,
        (await frames.next()).value,
        (await frames.next()).value,
      ];

      expect(framesOf(emitted)).toEqual([
        { toSeq: 2, values: ["first"] },
        { toSeq: 3, values: ["second"] },
        { toSeq: 4, values: ["effect"] },
      ]);
    } finally {
      await client.close();
    }
  });

  it("emits a response that arrived before its send was lost, then the effect behind it, ahead of what the resumed session catches up on", async () => {
    // The response answers its request though the send then fails with the
    // connection, so nothing is sent again. The restore sets the session's
    // watches once more, since the drop came before the response had been
    // applied, and what that brings follows the catch-up.

    const signer = await Identity.fromPassphrase(
      "memory-v2-effect-behind-lost-watch-response",
    );
    const space = signer.did();
    const documentId = "of:effect-behind-lost-watch-response" as URI;
    const transport = new EffectBehindWatchResponseTransport(space, [
      { response: sync(0, 1, []) },
      {
        response: sync(1, 2, [upsert(documentId, 2, { value: "answered" })]),
        effect: sync(2, 3, [upsert(documentId, 3, { value: "effect" })]),
        loses: true,
      },
      { response: sync(4, 5, [upsert(documentId, 5, { value: "set again" })]) },
    ]);
    transport.reopened = {
      resumed: true,
      sync: sync(3, 4, [upsert(documentId, 4, { value: "caught up" })]),
    };
    const client = await MemoryV2Client.Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport,
    });
    const session = await client.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      const view = await session.watchAdd([watch("of:lost-first")]);
      const frames = view.subscribeSync();
      await session.watchAdd([watch(documentId)]);
      const emitted = [
        (await frames.next()).value,
        (await frames.next()).value,
        (await frames.next()).value,
        (await frames.next()).value,
      ];

      expect(transport.requests).toEqual([
        "session.watch.add",
        "session.watch.add",
        "session.watch.set",
      ]);
      expect(framesOf(emitted)).toEqual([
        { toSeq: 2, values: ["answered"] },
        { toSeq: 3, values: ["effect"] },
        { toSeq: 4, values: ["caught up"] },
        { toSeq: 5, values: ["set again"] },
      ]);
      expect(view.snapshot().entities.map((entity) => entity.document))
        .toEqual([{ value: "set again" }]);
    } finally {
      await client.close();
    }
  });

  it("emits overlapping responses that arrived before the connection was lost, then the effect behind them, ahead of what the resumed session catches up on", async () => {
    const signer = await Identity.fromPassphrase(
      "memory-v2-effect-behind-lost-overlapping-responses",
    );
    const space = signer.did();
    const firstId = "of:lost-overlapping-first" as URI;
    const documentId = "of:lost-overlapping-document" as URI;
    const transport = new EffectBehindWatchResponseTransport(space, [
      { response: sync(0, 1, []) },
      {
        response: sync(1, 2, [upsert(firstId, 2, { value: "first" })]),
        holds: true,
      },
      {
        response: sync(2, 3, [upsert(documentId, 3, { value: "response" })]),
        effect: sync(3, 4, [upsert(documentId, 4, { value: "effect" })]),
        loses: true,
      },
      { response: sync(5, 6, []) },
    ]);
    transport.reopened = {
      resumed: true,
      sync: sync(4, 5, [upsert(documentId, 5, { value: "caught up" })]),
    };
    const client = await MemoryV2Client.Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport,
    });
    const session = await client.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    session.setConcurrentWatchRefresh(true);

    try {
      const view = await session.watchAdd([watch("of:lost-overlapping-root")]);
      const frames = view.subscribeSync();
      await Promise.all([
        session.watchAdd([watch(firstId)]),
        session.watchAdd([watch(documentId)]),
      ]);
      const emitted = [
        (await frames.next()).value,
        (await frames.next()).value,
        (await frames.next()).value,
        (await frames.next()).value,
      ];
      await session.whenRestored();

      expect(transport.requests).toEqual([
        "session.watch.add",
        "session.watch.add",
        "session.watch.add",
        "session.watch.set",
      ]);
      expect(framesOf(emitted)).toEqual([
        { toSeq: 2, values: ["first"] },
        { toSeq: 3, values: ["response"] },
        { toSeq: 4, values: ["effect"] },
        { toSeq: 5, values: ["caught up"] },
      ]);
      expect(
        view.snapshot().entities.find((entity) => entity.id === documentId)
          ?.document,
      ).toEqual({ value: "caught up" });
    } finally {
      await client.close();
    }
  });

  it("emits a restored watch set's response ahead of the effect that arrived just after it", async () => {
    const signer = await Identity.fromPassphrase(
      "memory-v2-restore-effect-order",
    );
    const space = signer.did();
    const documentId = "of:restore-effect-order" as URI;
    const transport = new EffectBehindWatchResponseTransport(space, [
      { response: sync(0, 1, [upsert(documentId, 1, { value: "first" })]) },
      {
        response: sync(1, 2, [upsert(documentId, 2, { value: "restored" })]),
        effect: sync(2, 3, [upsert(documentId, 3, { value: "effect" })]),
      },
    ]);
    const client = await MemoryV2Client.Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport,
    });
    const session = await client.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      const view = await session.watchAdd([watch(documentId)]);
      const frames = view.subscribeSync();
      transport.drop();
      const emitted = [
        (await frames.next()).value,
        (await frames.next()).value,
      ];

      expect(transport.requests).toEqual([
        "session.watch.add",
        "session.watch.set",
      ]);
      expect(framesOf(emitted)).toEqual([
        { toSeq: 2, values: ["restored"] },
        { toSeq: 3, values: ["effect"] },
      ]);
      expect(view.snapshot().entities.map((entity) => entity.document))
        .toEqual([{ value: "effect" }]);
    } finally {
      await client.close();
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
    const client = await MemoryV2Client.Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport,
    });
    const session = await client.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      // The connection drops under the first request, which fails; made
      // again once the session is back, it goes to the session that replaces
      // the one the effect came on.
      const failed = await session.watchAddSync([watch(watchedId)]).catch((
        error,
      ) => error);
      expect(MemoryV2Client.connectionDeliveryOf(failed)).toBeDefined();
      await failed.readyToRetry();
      const result = await session.watchAddSync([watch(watchedId)]);

      expect(transport.watchAddCount).toBe(2);
      expect(result.precedingSyncs).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("applies what a re-delivery that is its session's first watch mutation brings", async () => {
    const signer = await Identity.fromPassphrase(
      "memory-v2-pre-watch-effect-heal",
    );
    const space = signer.did();
    const schema: JSONSchemaObj = { type: "string", title: "first-watch-set" };
    const schemaId = `cid:${internSchemaAsTaggedHashString(schema)}` as URI;
    const referrerId = "of:first-watch-set-referrer" as URI;
    const aheadId = "of:first-watch-set-ahead" as URI;
    const laterId = "of:first-watch-set-later" as URI;
    const referrer = {
      value: {
        carried: {
          "/": {
            "link@1": {
              id: "of:first-watch-set-target",
              path: [],
              schema: { $ref: schemaId },
            },
          },
        },
      },
    };
    const transport = new FirstWatchSetTransport(
      space,
      sync(0, 1, [upsert(aheadId, 1, { value: "ahead" })]),
      sync(1, 2, [
        upsert(schemaId, 2, { value: schema }),
        upsert(referrerId, 2, referrer),
      ]),
    );
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-first-watch-set"),
    }, new SingleSessionFactory(transport));
    try {
      const provider = storageManager.open(space) as TestProvider;
      const replica = provider.replica as SpaceReplica;
      await replica.ensureSession();

      // A quarantine on a session with no watch view yet, as a remounted
      // session's is: nothing has been asked of it but this re-delivery.
      replica.accessForTestingOnly.applySessionSync(
        sync(0, 1, [upsert(referrerId, 1, referrer)]),
        "integrate",
      );
      await replica.inputSynced();

      expect(provider.get(aheadId)?.value).toBe("ahead");
      expect(provider.get(referrerId)).toEqual(referrer);

      transport.push(sync(2, 3, [upsert(laterId, 3, { value: "later" })]));
      await replica.framesApplied();

      expect(provider.get(laterId)?.value).toBe("later");
    } finally {
      await storageManager.close();
    }
  });
});

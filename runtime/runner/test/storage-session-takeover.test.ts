import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import {
  connect,
  loopback,
  type SpaceSession,
  type Transport,
} from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { Runtime } from "../src/runtime.ts";
import type { SessionFactory } from "../src/storage/v2.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

/** Discards an accepted resume's reply before replacing its connection. */
class LostResumeTransport implements Transport {
  readonly #server: Server;
  #active: Transport;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #closing: Promise<void>[] = [];
  #dropNextResume = false;
  #dropRequestId: string | undefined;
  #lostReplies = 0;
  #staleResumeRefusals = 0;

  constructor(server: Server) {
    this.#server = server;
    this.#active = this.#open();
  }

  get lostReplies(): number {
    return this.#lostReplies;
  }

  get staleResumeRefusals(): number {
    return this.#staleResumeRefusals;
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload);
    if (
      this.#dropNextResume && isObjectNotArray(message) &&
      message.type === "session.open" &&
      isObjectNotArray(message.session) &&
      typeof message.session.sessionToken === "string" &&
      typeof message.requestId === "string"
    ) {
      this.#dropNextResume = false;
      this.#dropRequestId = message.requestId;
    }
    await this.#active.send(payload);
  }

  async close(): Promise<void> {
    await this.#active.close();
    await Promise.all(this.#closing);
  }

  delivered(): Promise<void> {
    return this.#active.delivered?.() ?? Promise.resolve();
  }

  reset(): void {
    const previous = this.#active;
    this.#active = this.#open();
    this.#closing.push(previous.close());
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  /** Starts a reconnect whose first accepted resume response is discarded. */
  loseNextResume(): void {
    this.#dropNextResume = true;
    this.reconnect();
  }

  /** Replaces the connection and starts restoring the reader's session. */
  reconnect(): void {
    this.reset();
    this.#closeReceiver(new Error("synthetic connection loss"));
  }

  #open(): Transport {
    const connection = loopback(this.#server);
    connection.setReceiver((payload) => {
      if (this.#active !== connection) return;
      const message = decodeMemoryBoundary(payload);
      if (isObjectNotArray(message) && message.type === "response") {
        if (
          message.requestId === this.#dropRequestId &&
          isObjectNotArray(message.ok) &&
          typeof message.ok.sessionToken === "string"
        ) {
          this.#dropRequestId = undefined;
          this.#lostReplies++;
          this.reset();
          this.#closeReceiver(new Error("synthetic lost resume reply"));
          return;
        }
        if (
          isObjectNotArray(message.error) &&
          message.error.name === "SessionRevokedError" &&
          typeof message.error.message === "string" &&
          message.error.message.includes("resume token is no longer valid")
        ) this.#staleResumeRefusals++;
      }
      this.#receiver(payload);
    });
    return connection;
  }
}

describe("storage session takeover", () => {
  for (
    const cause of [
      "server takeover",
      "lost resume reply",
      "ordinary reconnect",
    ]
  ) {
    const terminal = cause === "server takeover";
    const description = terminal
      ? `returns an error for an already loaded document after ${cause}`
      : `keeps an already loaded document subscribed through ${
        cause === "lost resume reply"
          ? "a reconnect whose resume reply is lost"
          : "an ordinary reconnect"
      }`;
    it(description, async () => {
      const owner = await Identity.fromPassphrase("storage session takeover");
      const space = owner.did();
      const document = "of:inbox-offers";
      const server = new Server({
        ...TEST_MEMORY_SERVER_AUTH,
        store: new URL(`memory://session-takeover-${crypto.randomUUID()}`),
        subscriptionRefreshDelayMs: "manual",
      });
      const writer = await connect({ transport: loopback(server) });
      const writerSession = await writer.mount(
        space,
        {},
        testSessionOpenAuthFactory,
      );
      let localSeq = 0;
      const write = async (offers: string[]) => {
        await writerSession.transact({
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: document,
            value: { value: { offers } },
          }],
        });
      };
      const transport = new LostResumeTransport(server);
      const reader = await connect({ transport });
      let session: SpaceSession | undefined;
      const factory: SessionFactory = {
        async create(target, _signer, options) {
          session = await reader.mount(
            target,
            options,
            testSessionOpenAuthFactory,
          );
          return { client: reader, session };
        },
      };
      const manager = TestStorageManager.create({
        as: owner,
        memoryHost: new URL("memory://"),
      }, factory);
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
      });
      const inbox = () =>
        runtime.getCellFromEntityId(space, document).key("offers").asSchema({
          type: "array",
          items: { type: "string" },
        });
      const ended: { target: string; error: Error }[] = [];
      manager.subscribeSpaceSessionError((target, error) =>
        ended.push({ target, error })
      );
      let replacement: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        await write(["first"]);
        const provider = manager.open(space);
        expect((await provider.sync(document)).error).toBeUndefined();
        expect(provider.replica.getDocument(document)?.value)
          .toEqual({ offers: ["first"] });
        const heldInbox = inbox();
        expect(await heldInbox.pull()).toEqual(["first"]);
        if (session === undefined) throw new Error("reader did not mount");

        if (cause === "server takeover") {
          replacement = await connect({ transport: loopback(server) });
          await replacement.mount(space, {
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }, testSessionOpenAuthFactory);
          await transport.delivered();
        } else if (cause === "lost resume reply") {
          // The next resume carries the session's resume key, so the server
          // takes the token the lost resume presented.
          transport.loseNextResume();
          await session.whenRestored();
          expect(transport.lostReplies).toBe(1);
          expect(transport.staleResumeRefusals).toBe(0);
        } else {
          transport.reconnect();
          await session.whenRestored();
        }
        expect(session.closeError?.name).toBe(
          terminal ? "SessionRevokedError" : undefined,
        );
        expect(ended).toEqual(
          terminal ? [{ target: space, error: session.closeError }] : [],
        );

        await write(["first", "second"]);
        await server.flushSessions([space]);
        await transport.delivered();
        const fresh = await writerSession.queryGraph({
          roots: [{ id: document, selector: { path: [], schema: false } }],
        });
        expect(
          fresh.entities.find((entity) => entity.id === document)?.document,
        )
          .toEqual({ value: { offers: ["first", "second"] } });
        expect(provider.replica.getDocument(document)?.value)
          .toEqual({ offers: terminal ? ["first"] : ["first", "second"] });
        const read = await provider.sync(document);
        if (terminal) {
          expect(read.error?.message).toContain("taken-over");
          await expect(heldInbox.pull()).rejects.toThrow("taken-over");
          await expect(inbox().pull()).rejects.toThrow("taken-over");
        } else {
          expect(read.error).toBeUndefined();
          expect(await heldInbox.pull()).toEqual(["first", "second"]);
          expect(await inbox().pull()).toEqual(["first", "second"]);
        }
        expect(ended).toHaveLength(terminal ? 1 : 0);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await manager.close();
        await reader.close();
        await replacement?.close();
        await writer.close();
        await server.close();
      }
    });
  }

  it("reports no session error after a takeover in a space an authoritative local store supplies", async () => {
    const owner = await Identity.fromPassphrase("local store takeover");
    const space = owner.did();
    const server = new Server({
      ...TEST_MEMORY_SERVER_AUTH,
      store: new URL(`memory://local-store-takeover-${crypto.randomUUID()}`),
    });
    const reader = await connect({ transport: loopback(server) });
    let session: SpaceSession | undefined;
    const factory: SessionFactory = {
      async create(target, _signer, options) {
        session = await reader.mount(
          target,
          options,
          testSessionOpenAuthFactory,
        );
        return { client: reader, session };
      },
    };
    const manager = TestStorageManager.create({
      as: owner,
      memoryHost: new URL("memory://"),
    }, factory);
    const ended: string[] = [];
    manager.subscribeSpaceSessionError((target) => ended.push(target));
    try {
      await manager.open(space).sync("of:local-store-document");
      if (session === undefined) throw new Error("reader did not mount");
      manager.installStoreReadThrough(space, () => undefined);
      session.handleRevoked("taken-over");
      expect(session.closeError?.name).toBe("SessionRevokedError");
      expect(manager.spaceSessionError(space)).toBeUndefined();
      expect(ended).toEqual([]);
    } finally {
      await manager.close();
      await reader.close();
      await server.close();
    }
  });

  for (const schemaless of [false, true]) {
    for (const victim of ["home", "foreign", "unrelated"] as const) {
      const description = victim === "unrelated"
        ? "keeps a linked read available after an unrelated session is taken over"
        : `rejects a linked read after its ${victim} session is taken over`;
      it(`${description} (${schemaless ? "schemaless" : "schema"})`, async () => {
        const owner = await Identity.fromPassphrase("linked inbox home");
        const foreignOwner = await Identity.fromPassphrase(
          "linked inbox foreign",
        );
        const unrelatedOwner = await Identity.fromPassphrase(
          "linked inbox unrelated",
        );
        const home = owner.did();
        const foreign = foreignOwner.did();
        const unrelated = unrelatedOwner.did();
        const homeDocument = "of:linked-inbox";
        const foreignDocument = "of:linked-offers";
        const server = new Server({
          ...TEST_MEMORY_SERVER_AUTH,
          store: new URL(
            `memory://linked-session-takeover-${crypto.randomUUID()}`,
          ),
          subscriptionRefreshDelayMs: "manual",
        });
        const writer = await connect({ transport: loopback(server) });
        const homeWriter = await writer.mount(
          home,
          {},
          testSessionOpenAuthFactory,
        );
        const foreignWriter = await writer.mount(
          foreign,
          {},
          testSessionOpenAuthFactory,
        );
        let localSeq = 0;
        const writeOffers = (offers: string[]) =>
          foreignWriter.transact({
            localSeq: ++localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: foreignDocument,
              value: { value: offers },
            }],
          });
        const transport = new LostResumeTransport(server);
        const reader = await connect({ transport });
        const sessions = new Map<string, SpaceSession>();
        const factory: SessionFactory = {
          async create(target, _signer, options) {
            const session = await reader.mount(
              target,
              options,
              testSessionOpenAuthFactory,
            );
            sessions.set(target, session);
            return { client: reader, session };
          },
        };
        const manager = TestStorageManager.create({
          as: owner,
          memoryHost: new URL("memory://"),
        }, factory);
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
        });
        const inbox = () => {
          const cell = runtime.getCellFromEntityId(home, homeDocument);
          return schemaless ? cell : cell.key("offers").asSchema({
            type: "array",
            items: { type: "string" },
          });
        };
        const ended: string[] = [];
        manager.subscribeSpaceSessionError((target) => ended.push(target));
        let replacement: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          await writeOffers(["first"]);
          await homeWriter.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: homeDocument,
              value: {
                value: {
                  offers: {
                    "/": {
                      "link@1": {
                        id: foreignDocument,
                        space: foreign,
                        path: [],
                      },
                    },
                  },
                },
              },
            }],
          });
          const heldInbox = inbox();
          const before = await heldInbox.pull();
          expect(sessions.has(foreign)).toBe(true);
          expect(before).toEqual(
            schemaless ? { offers: ["first"] } : ["first"],
          );
          if (victim === "unrelated") {
            expect((await manager.open(unrelated).sync("of:unrelated")).error)
              .toBeUndefined();
          }
          const victimSpace = victim === "home"
            ? home
            : victim === "foreign"
            ? foreign
            : unrelated;
          const session = sessions.get(victimSpace);
          if (session === undefined) throw new Error("reader did not mount");
          replacement = await connect({ transport: loopback(server) });
          await replacement.mount(victimSpace, {
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }, testSessionOpenAuthFactory);
          await transport.delivered();
          expect(manager.spaceSessionError(victimSpace)?.name)
            .toBe("SessionRevokedError");
          expect(ended).toEqual([victimSpace]);

          await writeOffers(["first", "second"]);
          await server.flushSessions([home, foreign, unrelated]);
          await transport.delivered();
          const fresh = await foreignWriter.queryGraph({
            roots: [{
              id: foreignDocument,
              selector: { path: [], schema: false },
            }],
          });
          expect(
            fresh.entities.find((entity) => entity.id === foreignDocument)
              ?.document,
          )
            .toEqual({ value: ["first", "second"] });
          expect(
            manager.open(foreign).replica.getDocument(foreignDocument)?.value,
          )
            .toEqual(victim === "foreign" ? ["first"] : ["first", "second"]);
          if (victim === "unrelated") {
            const expected = schemaless
              ? { offers: ["first", "second"] }
              : ["first", "second"];
            expect(await heldInbox.pull()).toEqual(expected);
            expect(await inbox().pull()).toEqual(expected);
          } else {
            await expect(heldInbox.pull()).rejects.toThrow("taken-over");
            await expect(inbox().pull()).rejects.toThrow("taken-over");
          }
        } finally {
          await runtime.dispose({ closeStorage: false });
          await manager.close();
          await reader.close();
          await replacement?.close();
          await writer.close();
          await server.close();
        }
      });
    }
  }
});

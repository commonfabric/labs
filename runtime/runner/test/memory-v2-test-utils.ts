import { assertEquals } from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type SessionOpenAuthMetadata,
  type SessionSync,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { newLoopbackServer } from "../src/storage/v2-emulate.ts";
import type {
  IStorageNotification,
  StorageNotification,
} from "../src/storage/interface.ts";
import {
  type Options as V2Options,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";

export const TEST_SESSION_OPEN_AUDIENCE =
  "did:key:z6Mk-runner-memory-v2-test-audience";
export const TEST_SESSION_OPEN_PRINCIPAL =
  "did:key:z6Mk-runner-memory-v2-test-principal";
export const TEST_SESSION_OPEN_CHALLENGE = {
  value: "challenge:runner-memory-v2-test",
  expiresAt: 1_000_000,
} as const;
export const testSessionOpenAuthMetadata = (
  challengeId: string,
): SessionOpenAuthMetadata => ({
  audience: TEST_SESSION_OPEN_AUDIENCE,
  challenge: {
    value: `challenge:runner-memory-v2-test:${challengeId}`,
    expiresAt: 1_000_000,
  },
});
export const TEST_HELLO_SESSION_OPEN: SessionOpenAuthMetadata = {
  audience: TEST_SESSION_OPEN_AUDIENCE,
  challenge: TEST_SESSION_OPEN_CHALLENGE,
};
export const TEST_MEMORY_SERVER_AUTH = {
  authorizeSessionOpen: () => TEST_SESSION_OPEN_PRINCIPAL,
  sessionOpenAuth: {
    audience: TEST_SESSION_OPEN_AUDIENCE,
  },
} as const;

/**
 * A shared in-process memory server for multi-manager harnesses (pair with
 * `EmulatedStorageManager.connectTo`), pinned to the runner test audience.
 * `subscriptionRefreshDelayMs: "manual"` disables timer-driven fan-out
 * entirely; either explicit synchronization point — `flushSessions()`, or
 * `idle()`, which drains held fan-out to keep its quiescence contract —
 * delivers it. The controlled-staleness shape.
 */
export const newSharedServer = (options?: {
  subscriptionRefreshDelayMs?: number | "manual";
  store?: URL;
  sessions?: MemoryV2Server.SessionRegistry;
}): MemoryV2Server.Server =>
  newLoopbackServer({
    ...options,
    audience: TEST_SESSION_OPEN_AUDIENCE,
  });

export const testSessionOpenAuthFactory: MemoryV2Client.SessionOpenAuthFactory =
  (
    _space,
    _session,
    context,
  ) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: {},
  });

export function testPrincipalSessionOpenAuthFactory(
  signer?: Signer,
): MemoryV2Client.SessionOpenAuthFactory {
  return (
    _space,
    _session,
    context,
  ) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: {
      principal: signer?.did(),
    },
  });
}

export class NotificationRecorder implements IStorageNotification {
  notifications: StorageNotification[] = [];
  onNotification?: (notification: StorageNotification) => void;

  next(notification: StorageNotification) {
    this.notifications.push(notification);
    this.onNotification?.(notification);
    return { done: false };
  }

  clear(): void {
    this.notifications = [];
  }
}

/** The wire-message shape scripted transports care about. `commit` stays
 * unknown here — transports that script transact verdicts cast it to the
 * commit shape they need. */
export type ScriptedTransportMessage = {
  type: string;
  requestId?: string;
  session?: { sessionId?: string };
  invocation?: { aud?: unknown; challenge?: unknown };
  watches?: Array<{
    query?: { roots?: Array<{ id: string }> };
  }>;
  commit?: unknown;
};

/**
 * Base class for scripted memory-v2 transports: owns the session ceremony
 * every scripted server answers identically — `hello` (with sessionOpen
 * challenge rotation), `session.open` (asserting the client echoes the last
 * issued challenge/audience), and `session.ack` — plus the receiver plumbing
 * and the `session/effect` server-push frame. Subclasses implement `handle()`
 * for everything the ceremony doesn't cover (watches, transact, …) and
 * override the small seams (`openServerSeq`/`ackServerSeq`, codec, `onHello`,
 * `onClose`) where a harness deviates.
 */
export abstract class ScriptedSessionTransport
  implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #sessionOpen: SessionOpenAuthMetadata = TEST_HELLO_SESSION_OPEN;
  #sessionOpenCount = 0;
  #helloCount = 0;

  readonly #script: {
    /** Challenge-id prefix; keep unique per transport class. */
    name: string;

    /** sessionId confirmed on session.open and stamped on effect frames. */
    sessionId: string;

    /** The space effect frames (emitSync) are addressed to. */
    space: MemorySpace;
  };

  constructor(
    script: {
      /** Challenge-id prefix; keep unique per transport class. */
      name: string;

      /** sessionId confirmed on session.open and stamped on effect frames. */
      sessionId: string;

      /** The space effect frames (emitSync) are addressed to. */
      space: MemorySpace;
    },
  ) {
    this.#script = script;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  /** serverSeq stamped on session.open confirmations. */
  protected openServerSeq(): number {
    return 0;
  }

  /** serverSeq stamped on session.ack confirmations. */
  protected ackServerSeq(): number {
    return this.openServerSeq();
  }

  /** Called for each hello before hello.ok goes out (e.g. count connections). */
  protected onHello(_helloCount: number): void {}

  /** Flags advertised on hello.ok — override to script an older server
   * (e.g. one without `pendingReadStacks`) or a newer one. Scripted
   * transports do NOT advertise `verdictCatchUpMarkers` by default: a
   * client that believed it would park every accept's promotion on markers
   * a hand-rolled script never emits. Tests that script markers
   * (pushSync with caughtUpLocalSeq) opt in by overriding this. */
  protected helloFlags(): ReturnType<typeof getMemoryProtocolFlags> {
    return { ...getMemoryProtocolFlags(), verdictCatchUpMarkers: false };
  }

  /** Wire codec seams — override together when a harness needs a specific
   * reconstruction context. */
  protected decode(payload: string): ScriptedTransportMessage {
    return decodeMemoryBoundary(payload) as unknown as ScriptedTransportMessage;
  }

  protected encode(message: unknown): string {
    return encodeMemoryBoundary(message as FabricValue);
  }

  /** Handle every message the shared ceremony doesn't (watches, transact, …).
   * Throw on message types the script does not expect. */
  protected abstract handle(
    message: ScriptedTransportMessage,
  ): void | Promise<void>;

  async send(payload: string): Promise<void> {
    const message = this.decode(payload);
    switch (message.type) {
      case "hello":
        this.onHello(++this.#helloCount);
        this.#sessionOpen = testSessionOpenAuthMetadata(
          `${this.#script.name}-hello-${this.#helloCount}`,
        );
        this.respond({
          type: "hello.ok",
          protocol: "memory",
          flags: this.helloFlags(),
          sessionOpen: this.#sessionOpen,
        });
        return;
      case "session.open":
        assertEquals(message.invocation?.aud, this.#sessionOpen.audience);
        assertEquals(
          message.invocation?.challenge,
          this.#sessionOpen.challenge.value,
        );
        this.#sessionOpen = testSessionOpenAuthMetadata(
          `${this.#script.name}-open-${++this.#sessionOpenCount}`,
        );
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: message.session?.sessionId ?? this.#script.sessionId,
            serverSeq: this.openServerSeq(),
            sessionOpen: this.#sessionOpen,
          },
        });
        return;
      case "session.ack":
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.ackServerSeq(),
          },
        });
        return;
      default:
        await this.handle(message);
        return;
    }
  }

  /** Notify the client the connection is closing. Default mirrors most
   * scripted transports; override to a no-op where teardown must stay
   * silent. */
  protected onClose(): void {
    this.disconnect();
  }

  close(): Promise<void> {
    this.onClose();
    return Promise.resolve();
  }

  protected respond(message: unknown): void {
    this.#receiver(this.encode(message));
  }

  /** Sever the connection from the server side (client sees a close). */
  protected disconnect(error?: Error): void {
    this.#closeReceiver(error);
  }

  /** Deliver an unsolicited server-push sync frame (the real server's
   * timer-batched `session/effect` fan-out). */
  emitSync(sync: SessionSync): void {
    this.respond({
      type: "session/effect",
      space: this.#script.space,
      sessionId: this.#script.sessionId,
      effect: sync,
    });
  }

  /** Revoke the session from the server side: the client terminates it and
   * closes its watch view — the sync/marker channel dies with it. */
  emitRevoked(reason: "taken-over" | "unauthorized" = "taken-over"): void {
    this.respond({
      type: "session/revoked",
      space: this.#script.space,
      sessionId: this.#script.sessionId,
      reason,
    });
  }
}

export class SingleSessionFactory implements SessionFactory {
  client: MemoryV2Client.Client | null = null;
  session: MemoryV2Client.SpaceSession | null = null;

  readonly #transport: MemoryV2Client.Transport;

  constructor(transport: MemoryV2Client.Transport) {
    this.#transport = transport;
  }

  async create(space: MemorySpace) {
    if (this.client !== null) {
      throw new Error(`Session already created for ${space}`);
    }
    const client = await MemoryV2Client.connect({
      transport: this.#transport,
    });
    const session = await client.mount(space, {}, testSessionOpenAuthFactory);
    this.client = client;
    this.session = session;
    return { client, session };
  }
}

export class TestStorageManager extends V2StorageManager {
  static create(options: V2Options, sessionFactory: SessionFactory) {
    return new TestStorageManager(options, sessionFactory);
  }

  private constructor(options: V2Options, sessionFactory: SessionFactory) {
    super(options, sessionFactory);
  }
}

/**
 * The serving runtime's loopback storage plane (serving-loop.md §1 plane
 * (a)): a StorageManager whose sessions connect to the memory server, in
 * process or over transports that reach it on the thread that holds it, as
 * the only commit path the loop's runtime uses, with the same signed
 * `session.open` production clients present. No parallel auth scheme: the
 * loopback session's principal is the service identity, verified by whatever
 * `authorizeSessionOpen` the host process configured, which is what makes
 * the read-row admission's holder matching (protocol.md §2) meaningful in
 * production.
 */

import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import type { LoopbackMemoryServer } from "./host-memory-server.ts";
import type { SpaceHostRegistration } from "../space-host.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../storage/v2.ts";
import { createSignedSessionOpenAuth } from "../storage/v2-remote-session.ts";
import { runInServingContext } from "./serving-context.ts";

/**
 * Where a loopback session connects: the memory server reached in-process,
 * or a factory of transports that reach it another way, such as a port to
 * the thread that holds it.
 */
export type LoopbackPlane =
  | LoopbackMemoryServer
  | { createTransport(): MemoryClient.Transport };

class LoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;

  readonly #plane: LoopbackPlane;

  readonly #onServerFrame?: (frame: string) => void;

  constructor(
    plane: LoopbackPlane,
    onServerFrame?: (frame: string) => void,
  ) {
    this.#plane = plane;
    this.#onServerFrame = onServerFrame;
  }

  /** The loopback transport, with each server frame taken in the serving
   * context and reported AFTER the session has taken it. */
  #transport(): MemoryClient.Transport {
    const inner = "createTransport" in this.#plane
      ? this.#plane.createTransport()
      : MemoryClient.loopback(this.#plane);
    const report = this.#onServerFrame;
    return {
      ...inner,
      setReceiver: (next) =>
        inner.setReceiver((payload) =>
          runInServingContext(true, () => {
            next(payload);
            report?.(payload);
          })
        ),
    };
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    if (signer === undefined) {
      throw new Error(
        "loopback serving sessions require the service identity signer",
      );
    }
    const client = await MemoryClient.connect({
      transport: this.#transport(),
    });
    try {
      const session = await client.mount(
        space,
        mountOptions,
        (
          targetSpace: string,
          descriptor: MemoryClient.MountOptions,
          context: MemoryClient.SessionOpenAuthContext,
        ) =>
          createSignedSessionOpenAuth(
            signer,
            targetSpace as MemorySpace,
            descriptor,
            context,
          ),
      );
      return { client, session };
    } catch (error) {
      // A failed mount must not leak the in-process connection (repeated
      // auth/transient failures would accumulate server-side sessions) —
      // the same close-before-rethrow RemoteSessionFactory.create does.
      await client.close().catch(() => {});
      throw error;
    }
  }
}

/**
 * The SpaceServer's storage manager: in-process transport, signed
 * session-open, the service identity as `as`. One manager per serving
 * runtime (per space activation) — the ExecutorHost's runtime factory
 * constructs and disposes it with the runtime.
 */
export class LoopbackStorageManager extends StorageManager {
  static connect(
    plane: LoopbackPlane,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
    /** DIAGNOSTIC (tests): each frame the server sends to this manager's
     * sessions, reported once the session has taken it. A session's own
     * termination arrives this way and nothing else reports it, so a test
     * that has to act after one waits on this. */
    onServerFrame?: (frame: string) => void,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      {
        ...options,
        // Placeholder: the loopback session factory never resolves a
        // storage address against this.
        memoryHost: new URL("memory://loopback"),
      },
      new LoopbackSessionFactory(plane, onServerFrame),
    );
  }

  /**
   * Loopback sessions are in-process — there is no per-space host to
   * resolve, so a site-table host hint can never take effect. Refuse
   * honestly (as the emulated loopback manager does) rather than accept
   * a registration that resets the provisional replica while every new
   * session still uses the co-hosted server.
   */
  override registerSpaceHostDetailed(): SpaceHostRegistration {
    return { accepted: false, reason: "no-remote-resolution" };
  }
}

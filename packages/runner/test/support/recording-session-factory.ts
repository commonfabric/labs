/**
 * A session factory over an in-process memory server, for a test that needs
 * to see what a runtime commits, or to act just before one commit is sent.
 */

import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { Server } from "@commonfabric/memory/v2/server";

import type { SessionFactory } from "../../src/storage/v2.ts";

/**
 * A loopback session factory whose sessions authorize as the signer each is
 * opened for, and which records the ids each commit it sends writes, one list
 * per commit, in the order they were sent. It can create spaces with a genesis
 * access list.
 */
export class RecordingSessionFactory implements SessionFactory {
  #server: Server;
  #commits: string[][] = [];
  #beforeNext = new Map<string, () => Promise<void>>();

  /** Constructs an instance whose sessions go to `server`. */
  constructor(server: Server) {
    this.#server = server;
  }

  /** The ids each commit sent so far writes, one list per commit. */
  get commits(): readonly (readonly string[])[] {
    return this.#commits;
  }

  /** Always `true`: the loopback server takes a genesis access list. */
  get supportsAclBootstrap(): true {
    return true;
  }

  /**
   * Runs `action` once, just before the next commit that writes the document
   * `id` is sent. A rejection from `action` takes the place of that commit's
   * result.
   */
  beforeNextCommitTo(id: string, action: () => Promise<void>): void {
    this.#beforeNext.set(id, action);
  }

  /** @inheritDoc */
  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(
      space,
      requested,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    const transact = session.transact.bind(session);
    (session as { transact: typeof transact }).transact = async (
      commit,
      beforeIssue,
    ) => {
      const ids = commit.operations.flatMap((operation) =>
        "id" in operation ? [operation.id] : []
      );
      this.#commits.push(ids);
      for (const id of ids) {
        const before = this.#beforeNext.get(id);
        if (before === undefined) continue;
        this.#beforeNext.delete(id);
        await before();
      }
      return await transact(commit, beforeIssue);
    };
    return { client, session };
  }
}

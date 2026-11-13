/**
 * A storage manager creating a space whose connection is lost around the
 * genesis commit, over a real memory server: the commit is sent again on the
 * next connection, unchanged, and the space is created once.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import * as Client from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";

import type { SessionFactory } from "../src/storage/v2.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const creator = await Identity.fromPassphrase("create-space-loss creator");
const other = await Identity.fromPassphrase("create-space-loss other");

/**
 * A storage manager for `creator` over a memory server of its own, whose
 * connection is lost once, at the first `transact` it sends: before the
 * server receives that commit, or, with `landed`, after the server has
 * applied it and before its answer arrives. `atLoss` runs as the connection
 * is lost. `commits` holds the commit of each `transact` sent, in order.
 */
function managerLosingGenesisConnection(
  options: { landed: boolean; atLoss?: () => void },
) {
  const server = new Server(TEST_MEMORY_SERVER_AUTH);
  const commits: unknown[] = [];
  const factory: SessionFactory = {
    async create(space, _signer, sessionOptions) {
      let receiver = (_payload: string) => {};
      let closeReceiver = (_error?: Error) => {};
      let connection: ReturnType<Server["connect"]> | undefined;
      let lost: unknown;
      const reset = () => {
        connection?.close();
        connection = undefined;
      };
      const client = await Client.connect({
        transport: {
          async send(payload) {
            connection ??= server.connect((message) => {
              // The answer to the commit the connection was lost on never
              // arrives, though the server sent it.
              if (message.type === "response" && message.requestId === lost) {
                return;
              }
              receiver(encodeMemoryBoundary(message));
            });
            const message = decodeMemoryBoundary(payload) as {
              type: string;
              requestId?: string;
              commit?: unknown;
            };
            if (message.type !== "transact") {
              await connection.receive(payload);
              return;
            }
            commits.push(message.commit);
            if (commits.length > 1) {
              await connection.receive(payload);
              return;
            }
            lost = message.requestId;
            if (options.landed) await connection.receive(payload);
            options.atLoss?.();
            reset();
            closeReceiver(Client.connectionError("test connection dropped"));
          },
          reset,
          close() {
            reset();
            return Promise.resolve();
          },
          setReceiver(next) {
            receiver = next;
          },
          setCloseReceiver(next) {
            closeReceiver = next;
          },
        },
      });
      const session = await client.mount(
        space,
        sessionOptions,
        testSessionOpenAuthFactory,
      );
      return { client, session };
    },
  };
  const manager = TestStorageManager.create(
    { as: creator, memoryHost: new URL("memory://") },
    factory,
  );
  return {
    manager,
    commits,
    /** The access list the server stores for `space`. */
    async storedAccessList(space: string): Promise<unknown> {
      return (await server.readDocument(space, aclDocId(space)))?.value;
    },
    async close() {
      await manager.closeNow();
      await server.close();
    },
  };
}

describe("storage-create-space-connection-loss", () => {
  it("returns the space, and stores its access list, when the connection is lost before the server receives the genesis commit", async () => {
    const t = managerLosingGenesisConnection({ landed: false });
    try {
      const space = await t.manager.createSpace({ [creator.did()]: "OWNER" });

      expect(t.commits.length).toBe(2);
      expect(await t.storedAccessList(space)).toEqual({
        [creator.did()]: "OWNER",
      });
    } finally {
      await t.close();
    }
  });

  it("returns the space when the connection is lost after the server applied the genesis commit, before its answer arrived", async () => {
    const t = managerLosingGenesisConnection({ landed: true });
    try {
      const space = await t.manager.createSpace({ [creator.did()]: "OWNER" });

      expect(t.commits.length).toBe(2);
      expect(await t.storedAccessList(space)).toEqual({
        [creator.did()]: "OWNER",
      });
    } finally {
      await t.close();
    }
  });

  it("sends the genesis commit again as it was first sent, though the caller's grants changed after the server applied it", async () => {
    // The server answers a commit it has already applied from its record only
    // when the commit sent again matches, so a genesis built again from grants
    // that have changed since is refused as a replay mismatch.

    const grants: Record<string, "OWNER"> = { [creator.did()]: "OWNER" };
    const t = managerLosingGenesisConnection({
      landed: true,
      atLoss: () => {
        grants[other.did()] = "OWNER";
      },
    });
    try {
      const space = await t.manager.createSpace(grants);

      expect(t.commits.length).toBe(2);
      expect(t.commits[1]).toEqual(t.commits[0]);
      expect(await t.storedAccessList(space)).toEqual({
        [creator.did()]: "OWNER",
      });
    } finally {
      await t.close();
    }
  });
});

/**
 * One client of a worker's runtime: where a message addressed to it goes, and
 * the id everything it owns is namespaced under.
 *
 * A worker runs one runtime and serves any number of clients. The first stands
 * the runtime up and speaks over the worker's own global; each later one
 * arrives over a duplex of its own and attaches to the runtime already
 * running. What separates them here is ownership -- whose subscription this
 * is, whose mount an event belongs to, what a disconnect takes down -- and not
 * authority, which is the runtime's single security context and the same for
 * all of them.
 */

import type { IPCRemotePost } from "@/protocol/mod.ts";
import { postToClient } from "./post-to-client.ts";

/** Identifies one client of a worker's runtime, for that client's lifetime. */
export type ClientId = number;

/** The worker's end of one client's duplex. */
export interface WorkerClient {
  /**
   * This client's id. Every key a client-owned resource is filed under
   * carries it, so two documents that each name their first mount `1` name
   * two different mounts.
   */
  readonly id: ClientId;

  /**
   * Posts one message to this client, returning whether what was asked for is
   * what went -- the contract {@link postToClient} states, which is the
   * owner's implementation of this method.
   */
  post(message: IPCRemotePost): boolean;
}

/**
 * The id of the client that initialized the runtime. Fixed rather than minted,
 * because it is the id every handler falls back to: a call that names no
 * client is the single-client call it has always been.
 */
export const OWNER_CLIENT_ID: ClientId = 0;

/**
 * The client that owns the worker: the one whose initialization stood the
 * runtime up, reached through the worker's own global rather than through a
 * port. There is exactly one per worker, which is why it is a value here
 * rather than something constructed -- it stands for the global the worker
 * already has.
 */
export const ownerClient: WorkerClient = {
  id: OWNER_CLIENT_ID,
  post: postToClient,
};

/**
 * Files a client-supplied id under the client that supplied it. Clients mint
 * their ids independently -- a VDOM mount id comes from a per-document counter
 * that starts at 1 in every document -- so such an id names a resource only
 * while there is one client, and this is what names one while there are
 * several.
 *
 * The id is a number and the separator a space, so the first space is always
 * the boundary however the rest of the key is spelled. That is what lets
 * {@link clientKeyPrefix} select one client's keys from a map by prefix.
 */
export function clientScopedKey(
  client: WorkerClient,
  key: string | number,
): string {
  return `${client.id} ${key}`;
}

/**
 * The prefix every key {@link clientScopedKey} builds for `client` starts
 * with, which is what a per-client teardown scans a map for.
 */
export function clientKeyPrefix(client: WorkerClient): string {
  return `${client.id} `;
}

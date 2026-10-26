/**
 * The memory server as a serving host reaches it. The host, the space
 * server, the outbox and the view-plan publisher name this type rather than
 * the server class, so that the host can run where the server's object is
 * not at hand (a worker of the same process) behind an implementation that
 * carries each member across. The in-process server satisfies it as it is.
 */

import type { ServerMessage } from "@commonfabric/memory/v2";
import type { Server } from "@commonfabric/memory/v2/server";

/**
 * The members of the memory server a serving host calls, as the server
 * declares them, less the ones below.
 */
type ServerMembers = Pick<
  Server,
  | "setServerExecutionObserver"
  | "hasLiveSessionsForSpace"
  | "hasLiveSessionFor"
  | "sessionReadCeiling"
  | "idle"
  | "flushSessions"
  | "noteExecutorCommit"
  | "noteLeaseReacquired"
  | "checkServedAclChange"
  | "commitServedAclChange"
  | "commitDelegatedAppend"
  | "engineForSpace"
  | "foreignWriteAuthorityFor"
  | "resolveSpaceOwner"
  | "setViewSelection"
>;

/**
 * The memory server, as a serving host reaches it: the in-process server
 * itself, or an implementation that carries each member to one across a
 * worker boundary. Two members the server returns from synchronously may
 * return a promise here, because what they return is built from state only
 * the server's thread holds; their callers await them. The members that
 * return synchronously everywhere are the ones an implementation elsewhere
 * reads from a mirror the server keeps current.
 */
export type HostMemoryServer = ServerMembers & {
  /** @see Server.demandForSpace */
  demandForSpace(
    ...args: Parameters<Server["demandForSpace"]>
  ):
    | ReturnType<Server["demandForSpace"]>
    | Promise<ReturnType<Server["demandForSpace"]>>;

  /** @see Server.viewInterestsForSpace */
  viewInterestsForSpace(
    ...args: Parameters<Server["viewInterestsForSpace"]>
  ):
    | ReturnType<Server["viewInterestsForSpace"]>
    | Promise<ReturnType<Server["viewInterestsForSpace"]>>;

  /**
   * Attaches a wave batch's sqlite cell databases for the in-process wave
   * commit sink. Absent where the sink runs elsewhere, which is where the
   * host is given a sink of its own instead.
   */
  attachWaveCommitSqliteDbs?: Server["attachWaveCommitSqliteDbs"];
};

/**
 * One connection the loopback storage plane holds to the memory server, as
 * `Server.connect()` hands one out.
 */
export type LoopbackConnection = {
  /** Hands one client frame to the server; settles once the server took it. */
  receive(payload: string): Promise<void>;

  /** Closes the connection, as the client's going away does. */
  close(): void;
};

/**
 * What the serving runtime's loopback storage plane needs of the memory
 * server: a connection per session client, which delivers the server's
 * messages to `send`. The in-process server is one; an implementation that
 * carries the frames to the server's thread is another.
 */
export type LoopbackMemoryServer = {
  connect(send: (message: ServerMessage) => void): LoopbackConnection;
};

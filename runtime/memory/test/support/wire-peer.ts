/**
 * A test's end of one memory connection, driven by wire messages rather than
 * through the client library, for tests of what the server does with a
 * message. Sessions are opened the way `testSessionOpenServerOptions`
 * admits them: the invocation carries the audience and the challenge, and no
 * signature.
 */

import type { FabricPlainObject } from "@commonfabric/api";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
} from "../../v2.ts";
import type { Server } from "../../v2/server.ts";

/** One connection to a server, with what it has been sent and not yet taken. */
export type WirePeer = {
  /** The server's end of the connection. */
  connection: ReturnType<Server["connect"]>;

  /** Messages the server sent that no call has taken, oldest first. */
  messages: ServerMessage[];

  /** The audience and the challenge the next signed request carries. */
  auth: SessionOpenAuthMetadata;

  /** Flags the server advertised in `hello.ok`. */
  flags: FabricPlainObject;
};

let nextRequest = 0;

/** Returns a request id no other call in this process has returned. */
export const requestId = (label: string): string => `${label}:${nextRequest++}`;

/** Opens a connection and completes the `hello` exchange on it. */
export const connectPeer = async (server: Server): Promise<WirePeer> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary({
    type: "hello",
    protocol: MEMORY_PROTOCOL,
    flags: getMemoryProtocolFlags(),
  }));
  const hello = messages.shift();
  if (hello?.type !== "hello.ok" || hello.sessionOpen === undefined) {
    throw new Error("expected `hello.ok` carrying a challenge");
  }
  return {
    connection,
    messages,
    auth: hello.sessionOpen,
    flags: hello.flags as FabricPlainObject,
  };
};

/** Hands `message` to the server, resolving once it has been handled. */
export const send = (
  peer: WirePeer,
  message: FabricPlainObject,
): Promise<void> => peer.connection.receive(encodeMemoryBoundary(message));

/**
 * Takes the response to `id` out of the peer's messages. Throws when the
 * server has sent none.
 */
export const takeResponse = <Result>(
  peer: WirePeer,
  id: string,
): ResponseMessage<Result> => {
  const index = peer.messages.findIndex((message) =>
    message.type === "response" && message.requestId === id
  );
  if (index === -1) {
    throw new Error(`the server sent no response to \`${id}\``);
  }
  const [response] = peer.messages.splice(index, 1);
  return response as ResponseMessage<Result>;
};

/**
 * Sends `message` under a request id of its own and returns the server's
 * response to it.
 */
export const request = async <Result>(
  peer: WirePeer,
  message: FabricPlainObject,
): Promise<ResponseMessage<Result>> => {
  const id = requestId(String(message.type));
  await send(peer, { ...message, requestId: id });
  return takeResponse<Result>(peer, id);
};

/**
 * Opens a session on `space`, signing nothing, and returns the server's
 * result. Throws when the server refuses the open.
 */
export const openSession = async (
  peer: WirePeer,
  space: string,
  session: SessionDescriptor = {},
): Promise<SessionOpenResult> => {
  const opened = await request<SessionOpenResult>(peer, {
    type: "session.open",
    space,
    session: session as FabricPlainObject,
    invocation: {
      aud: peer.auth.audience,
      challenge: peer.auth.challenge.value,
    },
  });
  if (opened.ok === undefined) {
    throw new Error(`session open failed: ${opened.error?.message}`);
  }
  peer.auth = opened.ok.sessionOpen;
  return opened.ok;
};

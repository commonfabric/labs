import { debugStr } from "@commonfabric/data-model";

import {
  compatibleMemoryProtocolFlags,
  getMemoryProtocolFlags,
  type HelloMessage,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type MemoryProtocolFlags,
  parseMemoryProtocolFlags,
  type ServerMessage,
  wireMemoryProtocolFlags,
} from "../v2.ts";

type TypedError = {
  name: string;
  message: string;
};

const toError = (name: string, message: string): TypedError => ({
  name,
  message,
});

export const respondToHello = (
  message: HelloMessage,
  expectedFlags: MemoryProtocolFlags = getMemoryProtocolFlags(),
): ServerMessage => {
  if (message.protocol !== MEMORY_PROTOCOL) {
    return {
      type: "response",
      requestId: "handshake",
      error: toError(
        "UnsupportedProtocol",
        `Unsupported protocol: ${message.protocol}`,
      ),
    };
  }
  const parsed = parseMemoryProtocolFlags(message.flags);
  if (
    parsed === null ||
    !compatibleMemoryProtocolFlags(parsed, expectedFlags)
  ) {
    return {
      type: "response",
      requestId: "handshake",
      error: toError(
        "ProtocolError",
        debugStr`memory flag mismatch: client=$quote,long${message.flags} server=$quote,long${expectedFlags}`,
      ),
    };
  }

  const response: HelloOkMessage = {
    type: "hello.ok",
    protocol: MEMORY_PROTOCOL,
    flags: wireMemoryProtocolFlags(expectedFlags),
  };
  return response;
};

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloMessage,
  MEMORY_PROTOCOL,
  wireMemoryProtocolFlags,
} from "../v2.ts";
import { respondToHello } from "../v2/handshake.ts";
import { parseClientMessage } from "../v2/server.ts";

/** The `hello` a server parses from a client that sent `protocol`. */
const helloFromWire = (protocol: string): HelloMessage => {
  const parsed = parseClientMessage(encodeMemoryBoundary({
    type: "hello",
    protocol,
    flags: wireMemoryProtocolFlags(getMemoryProtocolFlags()),
  }));
  if (parsed?.type !== "hello") {
    throw new Error(`the hello did not parse: ${JSON.stringify(parsed)}`);
  }
  return parsed;
};

describe("respondToHello()", () => {
  it("returns `hello.ok` carrying the server's flags for the memory protocol", () => {
    expect(respondToHello(helloFromWire(MEMORY_PROTOCOL))).toEqual({
      type: "hello.ok",
      protocol: MEMORY_PROTOCOL,
      flags: wireMemoryProtocolFlags(getMemoryProtocolFlags()),
    });
  });

  it("returns an `UnsupportedProtocol` error naming any other protocol", () => {
    // The parser takes the protocol as a string, so a peer speaking some
    // other protocol reaches the handshake with it.

    expect(respondToHello(helloFromWire("memory/0"))).toEqual({
      type: "response",
      requestId: "handshake",
      error: {
        name: "UnsupportedProtocol",
        message: "Unsupported protocol: memory/0",
      },
    });
  });
});

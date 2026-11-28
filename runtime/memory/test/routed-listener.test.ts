import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";
import { listeningPort } from "../v2/routed-listener.ts";

describe("listeningPort()", () => {
  it("reads the port of a TCP address", () => {
    expect(listeningPort({ address: "127.0.0.1", family: "IPv4", port: 8443 }))
      .toBe(8443);
    expect(listeningPort({ address: "::1", family: "IPv6", port: 0 })).toBe(0);
  });

  it("refuses a server bound to a pipe path or not listening", () => {
    for (const address of ["/tmp/memory.sock", null]) {
      expect(() => listeningPort(address)).toThrow(
        "Private memory listener failed",
      );
    }
  });
});

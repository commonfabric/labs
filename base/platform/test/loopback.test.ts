import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isLoopbackHostname } from "@commonfabric/platform/loopback";

describe("isLoopbackHostname()", () => {
  it("returns `true` for the loopback names and addresses a URL normalizes to", () => {
    for (
      const hostname of [
        "localhost",
        "localhost.",
        "[::1]",
        "127.0.0.1",
        "127.1.2.3",
        "[::ffff:7f00:1]",
      ]
    ) {
      expect(isLoopbackHostname(hostname)).toBe(true);
    }
  });

  it("returns `false` for other hosts, including near misses", () => {
    for (
      const hostname of [
        "example.com",
        "localhost.example.com",
        "128.0.0.1",
        "127.0.0",
        "[::2]",
        "[::ffff:8000:1]",
        "::1",
      ]
    ) {
      expect(isLoopbackHostname(hostname)).toBe(false);
    }
  });
});

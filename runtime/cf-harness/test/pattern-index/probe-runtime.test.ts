import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { openProbeRuntime } from "../../src/pattern-index/probe-runtime.ts";

describe("openProbeRuntime()", () => {
  it("abstains without an identity to act as", async () => {
    expect(
      await openProbeRuntime(
        undefined,
        new URL("https://toolshed.example/"),
        "enforce-explicit",
      ),
    ).toBeUndefined();
  });

  it({
    name: "opens a throwaway space that exists",
    // The emulated storage reaches SQLite through FFI, which stays loaded
    // for the process.
    sanitizeResources: false,
  }, async () => {
    const identity = await Identity.fromPassphrase("probe-runtime space");
    const opened = await openProbeRuntime(
      identity,
      new URL("https://toolshed.example/"),
      "enforce-explicit",
    );
    expect(opened).toBeDefined();
    try {
      const { pieces } = opened!;
      expect(pieces.getSpace()).not.toBe(identity.did());
      expect(await pieces.runtime.spaceExists(pieces.getSpace())).toBe(true);
    } finally {
      await opened!.close();
    }
  });

  it({
    name: "runs the probe under the session runtime's read ceiling",
    // The emulated storage reaches SQLite through FFI, which stays loaded
    // for the process.
    sanitizeResources: false,
  }, async () => {
    const identity = await Identity.fromPassphrase("probe-runtime ceiling");
    const opened = await openProbeRuntime(
      identity,
      new URL("https://toolshed.example/"),
      "enforce-explicit",
      {
        cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
        cfcReadOnExceed: "skip",
      },
    );
    expect(opened).toBeDefined();
    try {
      expect(opened!.pieces.runtime.cfcReadMaxConfidentiality).toEqual([
        "did:key:zOwner",
        "did:key:zFacet",
      ]);
      expect(opened!.pieces.runtime.cfcReadOnExceed).toBe("skip");
    } finally {
      await opened!.close();
    }
  });
});

/**
 * The package exposes this directory as `./codec-realm`, so what the barrel
 * re-exports is the public surface. A name added to `interface.ts` and not
 * added here is invisible to every consumer outside this package, and nothing
 * else would say so: the engine's own tests reach past the barrel.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { REALM_CODEC } from "@/codec-common";
import {
  createBaseRealmRegistry,
  REALM_FORMAT,
  REALM_FORMAT_VERSION,
  RealmCodecEngine,
} from "@/codec-realm";

describe("codec-realm/index", () => {
  it("exports the format descriptor, keyed by this format's codec symbol", () => {
    expect(REALM_FORMAT.codecSymbol).toBe(REALM_CODEC);
  });

  it("exports the version the marker carries", () => {
    expect(REALM_FORMAT_VERSION).toBe("fvr1");
  });

  it("exports a registry factory and the engine that reads one", () => {
    const engine = new RealmCodecEngine({
      registry: createBaseRealmRegistry(),
    });

    // A base registry carries the primitives and no fabric class, so this
    // round-trips plain data and nothing else -- which is enough to show the
    // two exports fit together.
    const encoded = engine.encode({ a: 1n, b: undefined });

    expect(encoded[0]).toEqual([REALM_FORMAT_VERSION]);
    expect(encoded[1]).toEqual({ a: 1n, b: undefined });
  });
});

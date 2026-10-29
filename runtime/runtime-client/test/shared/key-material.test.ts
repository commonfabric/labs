import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ProblematicValue,
  UnknownValue,
} from "@commonfabric/data-model/codec-common";
import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";

import { findKeyMaterial } from "@/shared/key-material.ts";

const keyPair = new FabricKeyPair(
  "Ed25519",
  new Uint8Array(32),
  new Uint8Array(32),
);

describe("findKeyMaterial()", () => {
  it("returns `undefined` for a value holding none", () => {
    expect(findKeyMaterial({
      identity: "did:key:z6Mk-someone",
      trustSnapshot: { id: "principal:did:key:z6Mk-someone" },
      atoms: [{ type: "Resource", subject: "did:key:z6Mk-someone" }],
    })).toBeUndefined();
  });

  it("returns `undefined` for a primitive", () => {
    expect(findKeyMaterial("did:key:z6Mk-someone")).toBeUndefined();
    expect(findKeyMaterial(undefined)).toBeUndefined();
    expect(findKeyMaterial(42)).toBeUndefined();
  });

  it("names the field a key pair sits directly under", () => {
    expect(findKeyMaterial({ identity: keyPair })).toBe("identity");
  });

  it("names the path of a key pair nested inside", () => {
    expect(findKeyMaterial({ trustSnapshot: { signer: keyPair } })).toBe(
      "trustSnapshot.signer",
    );
  });

  it("names the index of a key pair inside an array", () => {
    expect(findKeyMaterial({ atoms: [{}, { key: keyPair }] })).toBe(
      "atoms[1].key",
    );
  });

  it("names the value itself when it is a key pair", () => {
    expect(findKeyMaterial(keyPair)).toBe("");
  });

  it("names the path of a key pair wrapped under an unknown wire tag", () => {
    // A tag this realm does not know decodes into an `UnknownValue` holding
    // whatever rode under it. Its state lives in a `#` field, so the walk
    // over enumerable properties sees an empty object and would pass a key
    // pair straight through.
    const unknown = new UnknownValue("Bytes@1", keyPair as unknown as never);
    expect(findKeyMaterial({ trustSnapshot: unknown })).toBe(
      "trustSnapshot.state",
    );
  });

  it("names the path of a key pair inside a value the decoder refused", () => {
    const problematic = new ProblematicValue(
      "Whatever@1",
      { signer: keyPair },
      "unreadable",
    );
    expect(findKeyMaterial({ trustSnapshot: problematic })).toBe(
      "trustSnapshot.state.signer",
    );
  });

  it("names the path of a key pair inside a native map or set", () => {
    // A `Map` has no enumerable own properties either, so its contents are
    // reached the same way an instance's state is.
    expect(findKeyMaterial({ hosts: new Map([["a", keyPair]]) })).toBe(
      "hosts{a}",
    );
    expect(findKeyMaterial({ atoms: new Set([keyPair]) })).toBe("atoms{}");
  });

  it("walks past a map and a set holding none, and finds what follows", () => {
    // The containers are walked through rather than around: an innocent one
    // neither refuses the frame nor stops the search before what comes after
    // it.
    expect(findKeyMaterial({ hosts: new Map([["a", "http://h/"]]) }))
      .toBeUndefined();
    expect(findKeyMaterial({ atoms: new Set(["public"]) })).toBeUndefined();
    expect(findKeyMaterial({
      hosts: new Map([["a", "http://h/"]]),
      atoms: new Set(["public"]),
      signer: keyPair,
    })).toBe("signer");
  });

  it("returns `undefined` for a cycle holding no key material", () => {
    // A context built on this side of the wire has not been through a decode,
    // so nothing has flattened it into a tree first.
    const cyclic: Record<string, unknown> = { identity: "did:key:z6Mk-a" };
    cyclic.self = cyclic;
    expect(findKeyMaterial(cyclic)).toBeUndefined();
  });

  it("finds a key pair reached past a cycle", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    cyclic.trustSnapshot = { signer: keyPair };
    expect(findKeyMaterial(cyclic)).toBe("trustSnapshot.signer");
  });
});

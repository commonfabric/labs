import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { createRef } from "../src/create-ref.ts";
import {
  formatFabricRef,
  HASH_RE,
  isFabricImportSpecifier,
  parseFabricRef,
  pinnedIdentity,
  withPin,
} from "../src/sandbox/fabric-import-specifier.ts";
import {
  isAllowedAuthoredImportSpecifier,
  isRuntimeModuleIdentifier,
} from "../src/sandbox/runtime-module-policy.ts";
import { toURI } from "../src/uri-utils.ts";

import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// These tests drive the sync parse internals directly (below the async flow
// boundaries that normally load the deferred compiler stack), so load it here.
await ensureCompilerStack();

const HASH = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";
const HASH_B = "Bvcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";
const HEX_LOOKING_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("fabric import specifiers", () => {
  it("returns undefined for non-fabric specifiers", () => {
    for (const specifier of ["./foo.ts", "commonfabric", "npm:x"]) {
      expect(parseFabricRef(specifier)).toBeUndefined();
      expect(isFabricImportSpecifier(specifier)).toBe(false);
    }
  });

  it("allows the public CFC authoring runtime module", () => {
    expect(parseFabricRef("commonfabric/cfc")).toBeUndefined();
    expect(isRuntimeModuleIdentifier("commonfabric/cfc")).toBe(true);
    expect(isAllowedAuthoredImportSpecifier("commonfabric/cfc")).toBe(true);
  });

  it("parses valid specifiers and formats canonically", () => {
    const cases = [
      {
        specifier: "cf:todo-list",
        expected: {
          ref: { kind: "slug", slug: "todo-list" },
        },
      },
      {
        specifier: "cf:todo-list/schemas",
        expected: {
          ref: { kind: "slug", slug: "todo-list" },
          subpath: "schemas",
        },
      },
      {
        specifier: "cf:/kitchen/todo-list",
        expected: {
          space: "kitchen",
          ref: { kind: "slug", slug: "todo-list" },
        },
      },
      {
        specifier: "cf:/kitchen/todo-list/a/b.ts",
        expected: {
          space: "kitchen",
          ref: { kind: "slug", slug: "todo-list" },
          subpath: "a/b.ts",
        },
      },
      {
        specifier: "cf:/did:key:z6MkFabricImportTest/todo-list",
        expected: {
          space: "did:key:z6MkFabricImportTest",
          ref: { kind: "slug", slug: "todo-list" },
        },
      },
      {
        specifier: "cf://host.example/kitchen/todo-list",
        expected: {
          host: "host.example",
          space: "kitchen",
          ref: { kind: "slug", slug: "todo-list" },
        },
      },
      {
        specifier: "cf://host.example:8000/kitchen/todo-list",
        expected: {
          host: "host.example:8000",
          space: "kitchen",
          ref: { kind: "slug", slug: "todo-list" },
        },
      },
      {
        specifier: `cf:/kitchen/todo-list@${HASH}`,
        expected: {
          space: "kitchen",
          ref: { kind: "slug", slug: "todo-list" },
          pin: HASH,
        },
      },
      {
        specifier: `cf:pattern:${HASH}`,
        expected: {
          ref: { kind: "uri", scheme: "pattern", hash: HASH },
        },
      },
      {
        specifier: `cf:pattern:${HEX_LOOKING_HASH}`,
        expected: {
          ref: { kind: "uri", scheme: "pattern", hash: HEX_LOOKING_HASH },
        },
      },
      {
        specifier: `cf:pattern:${HASH}@${HASH}`,
        canonical: `cf:pattern:${HASH}`,
        expected: {
          ref: { kind: "uri", scheme: "pattern", hash: HASH },
        },
      },
      {
        specifier: `cf:/kitchen/of:fid1:${HASH}`,
        expected: {
          space: "kitchen",
          ref: { kind: "uri", scheme: "of", hash: HASH },
        },
      },
      {
        specifier: `cf:of:fid1:${HASH}`,
        expected: {
          ref: { kind: "uri", scheme: "of", hash: HASH },
        },
      },
      {
        specifier: `cf:fid1:${HASH}`,
        canonical: `cf:of:fid1:${HASH}`,
        expected: {
          ref: { kind: "uri", scheme: "of", hash: HASH },
        },
      },
      {
        specifier: `cf:computed:fid1:${HASH}`,
        expected: {
          ref: { kind: "uri", scheme: "computed", hash: HASH },
        },
      },
      {
        specifier: `cf:/kitchen/computed:fid1:${HASH}`,
        expected: {
          space: "kitchen",
          ref: { kind: "uri", scheme: "computed", hash: HASH },
        },
      },
    ];

    for (const { specifier, expected, canonical } of cases) {
      const parsed = parseFabricRef(specifier);
      expect(parsed).toEqual(expected);
      expect(isFabricImportSpecifier(specifier)).toBe(true);
      expect(isAllowedAuthoredImportSpecifier(specifier)).toBe(true);
      expect(formatFabricRef(parsed!)).toBe(canonical ?? specifier);
      expect(parseFabricRef(formatFabricRef(parsed!))).toEqual(parsed);
    }
  });

  it("rejects malformed fabric specifiers", () => {
    const invalid = [
      "cf://host.example/todo-list",
      "cf:todo-list@abc",
      `cf:todo-list@${HASH}=`,
      `cf:todo-list@${HASH}x`,
      `cf:pattern:${HASH}@${HASH_B}`,
      `cf:pattern:${HASH.toUpperCase()}@${HASH}`,
      `cf:of:${HASH}`,
      // The scheme requires the fid1 segment, like of:.
      `cf:computed:${HASH}`,
      // The retired fid2 tag form is not readable.
      `cf:of:fid2:computed:${HASH}`,
      "cf:data:abc",
      `cf:module/${HASH}`,
      "cf:cache-root/x",
      "cf:source-root/tests/main.test.tsx",
      "cf:data-file/data/cities.json",
      "cf:Has_Upper",
      "cf:",
      "cf:/",
      "cf://",
      "cf:/kitchen/",
      "cf:todo-list//x",
      "cf:todo-list/",
      "cf:/kitchen/todo-list//deep/x",
    ];

    for (const specifier of invalid) {
      expect(() => parseFabricRef(specifier)).toThrow();
      expect(isFabricImportSpecifier(specifier)).toBe(false);
      expect(isAllowedAuthoredImportSpecifier(specifier)).toBe(false);
    }
  });

  it("reports pinned identities without resolving mutable pointers", () => {
    expect(pinnedIdentity(parseFabricRef(`cf:pattern:${HASH}`)!)).toBe(HASH);
    expect(pinnedIdentity(parseFabricRef(`cf:todo-list@${HASH}`)!)).toBe(HASH);
    expect(pinnedIdentity(parseFabricRef("cf:todo-list")!)).toBeUndefined();
  });

  it("adds pins without changing the original ref", () => {
    const ref = parseFabricRef("cf:/kitchen/todo-list")!;
    const pinned = withPin(ref, HASH);
    expect(formatFabricRef(ref)).toBe("cf:/kitchen/todo-list");
    expect(formatFabricRef(pinned)).toBe(`cf:/kitchen/todo-list@${HASH}`);
  });

  it("withPin on a pattern: URI ref is consistent with the conflicting-pin rule", () => {
    const ref = parseFabricRef(`cf:pattern:${HASH}`)!;
    // Equal pin: already content-addressed; no pin is added.
    expect(formatFabricRef(withPin(ref, HASH))).toBe(`cf:pattern:${HASH}`);
    // Different pin: contradicts the content address - never representable.
    expect(() => withPin(ref, HASH_B)).toThrow("conflicting pin");
  });

  it("formatFabricRef refuses a host-qualified ref without a space", () => {
    const ref = parseFabricRef("cf://host.example/kitchen/todo-list")!;
    expect(() => formatFabricRef({ ...ref, space: undefined })).toThrow(
      "host-qualified refs require a space",
    );
  });

  it("accepts real module identities produced by computeModuleHashes", () => {
    const hashes = computeModuleHashes({
      files: [{ name: "/main.ts", contents: "export const value = 1;" }],
      main: "/main.ts",
    });
    const hash = hashes.get("/main.ts")!;

    expect(HASH_RE.test(hash)).toBe(true);
    expect(parseFabricRef(`cf:pattern:${hash}`)).toEqual({
      ref: { kind: "uri", scheme: "pattern", hash },
    });
  });

  it("accepts real entity URIs produced by createRef and toURI", () => {
    const uri = toURI(createRef({ x: 1 }, "fabric import canary"));
    const match = /^of:fid1:([A-Za-z0-9_-]{43})$/.exec(uri);

    expect(match).not.toBeNull();
    expect(parseFabricRef(`cf:/somespace/${uri}`)).toEqual({
      space: "somespace",
      ref: { kind: "uri", scheme: "of", hash: match![1] },
    });
  });

  it("round-trips real computed: URIs produced by createRef and toURI", () => {
    const uri = toURI(
      createRef({ x: 1 }, "fabric import canary"),
      "computed",
    );
    const match = /^computed:fid1:([A-Za-z0-9_-]{43})$/.exec(uri);

    expect(match).not.toBeNull();
    const parsed = parseFabricRef(`cf:/somespace/${uri}`);
    expect(parsed).toEqual({
      space: "somespace",
      ref: { kind: "uri", scheme: "computed", hash: match![1] },
    });
    expect(formatFabricRef(parsed!)).toBe(`cf:/somespace/${uri}`);
  });
});

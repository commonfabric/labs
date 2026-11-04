/**
 * The walk itself is `replaceArtifacts()`, covered in `encodable-form.test.ts`.
 * What this module adds is the HOOK: the walk bound to `noteDerivedCopy`, so
 * every copy it makes says where it came from. That is not visible in the
 * replaced value at all -- trust and the content-addressed entry ref live in
 * identity-keyed side tables -- so it is what these cases look at.
 *
 * The one claim the module makes about a result's type is that a pattern the
 * builder made flattens to a `FabricValue`. That rests on what the builder
 * produces, so its cases build real patterns, one for each kind of thing a
 * graph can hold, and check each result as the data model would.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type FabricValue, isValidFabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { flattenBuilderArtifacts } from "../src/storage-preflight.ts";
import { Runtime } from "../src/runtime.ts";
import type { PatternFactory } from "../src/builder/types.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  brandTrustedBuilderArtifact,
  isTrustedBuilderArtifact,
  resolveOriginal,
} from "../src/builder/pattern-metadata.ts";

/** Builds an artifact of the shape `builder/module.ts` produces. */
function artifact(serialized: unknown): Record<string, unknown> {
  return {
    type: "javascript",
    implementation: () => "not representable",
    toEncodableForm: () => serialized,
  };
}

describe("flattenBuilderArtifacts()", () => {
  it("runs the walk", () => {
    const value = { tools: { send: { handler: artifact({ ok: true }) } } };
    expect(flattenBuilderArtifacts(value))
      .toEqual({ tools: { send: { handler: { ok: true } } } });
  });

  it("records where each copy came from", () => {
    const original = artifact({ ok: true });
    const result = flattenBuilderArtifacts({ held: original }) as {
      held: unknown;
    };
    expect(resolveOriginal(result.held)).toBe(original);
  });

  it("records the container it rebuilt, not only the artifact", () => {
    const value = { held: artifact({ ok: true }) };
    const result = flattenBuilderArtifacts(value);
    expect(result).not.toBe(value);
    expect(resolveOriginal(result)).toBe(value);
  });

  it("carries trust across the copy", () => {
    // Trust is why the derivation is recorded eagerly: a serialized copy of a
    // trusted artifact has to stay trusted, and nothing about the copy's own
    // bytes could establish that -- the brand lives in a runner-private
    // WeakSet keyed on identity, which a copy does not share.
    const original = brandTrustedBuilderArtifact({
      held: artifact({ ok: true }),
    });
    expect(isTrustedBuilderArtifact(original)).toBe(true);

    const result = flattenBuilderArtifacts(original);
    expect(result).not.toBe(original);
    expect(isTrustedBuilderArtifact(result)).toBe(true);
  });

  it("leaves a value it did not copy out of the side table", () => {
    // Nothing was replaced, so the value is returned by identity and is its
    // own original -- not a derivation of anything.
    const value = { a: 1, b: { c: [1, 2, 3] } };
    expect(flattenBuilderArtifacts(value)).toBe(value);
    expect(resolveOriginal(value)).toBe(value);
  });

  describe("a pattern the builder made", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let commonfabric: ReturnType<typeof createTrustedBuilder>["commonfabric"];

    beforeEach(async () => {
      const signer = await Identity.fromPassphrase("test operator");
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      ({ commonfabric } = createTrustedBuilder(runtime));
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    /** Flattens a builder-made pattern, typed as the overload promises. */
    function flattened<T, R>(pattern: PatternFactory<T, R>): FabricValue {
      return flattenBuilderArtifacts(pattern);
    }

    it("flattens to a `FabricValue` when its result aliases an input", () => {
      const { pattern } = commonfabric;
      const p = pattern<{ x: number }>(({ x }) => ({ y: x }));
      expect(isValidFabricValue(flattened(p))).toBe(true);
    });

    it("flattens to a `FabricValue` when it holds a lift", () => {
      const { lift, pattern } = commonfabric;
      const double = lift((n: number) => n * 2);
      const p = pattern<{ x: number }>(({ x }) => ({ y: double(x) }));
      expect(isValidFabricValue(flattened(p))).toBe(true);
    });

    it("flattens to a `FabricValue` when it holds a handler", () => {
      const { handler, pattern } = commonfabric;
      const bump = handler(
        { type: "object", properties: {} },
        { type: "object", properties: { n: { type: "number" } } },
        () => {},
      );
      const p = pattern<{ n: number }>(({ n }) => ({ bump: bump({ n }) }));
      expect(isValidFabricValue(flattened(p))).toBe(true);
    });

    it("flattens to a `FabricValue` when it holds a nested pattern", () => {
      const { pattern } = commonfabric;
      const inner = pattern<{ a: number }>(({ a }) => ({ b: a }));
      const outer = pattern<{ x: number }>(({ x }) => ({ y: inner({ a: x }) }));
      expect(isValidFabricValue(flattened(outer))).toBe(true);
    });

    it("flattens to a `FabricValue` when it maps with a pattern", () => {
      // Authored `.map()` is lowered by the transformer to `mapWithPattern()`,
      // which is what the builder takes directly.

      const { pattern } = commonfabric;
      const op = pattern(({ element }: any) => ({ v: element }));
      const p = pattern<{ items: number[] }>(({ items }) => ({
        out: (items as any).mapWithPattern(op, {}),
      }));
      expect(isValidFabricValue(flattened(p))).toBe(true);
    });

    it("flattens to a `FabricValue` when its result holds natives", () => {
      const { pattern } = commonfabric;
      const p = pattern(() => ({
        bytes: new Uint8Array([1, 2]),
        when: new Date(0),
      }));
      expect(isValidFabricValue(flattened(p))).toBe(true);
    });
  });
});

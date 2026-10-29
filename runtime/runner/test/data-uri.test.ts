/**
 * Minting a `data:` URI from a value, which has to do two things at once.
 *
 * The URI carries its own bytes, so nothing the value names can stay
 * relative: a link is resolved against a base before it is written, and one
 * that was already absolute is left as it is. And the URI stands in for the
 * value wherever an id would, so what comes back has to be what went in --
 * key insertion order cannot show through, and the cases usually rounded off
 * on the way (a negative zero, a non-finite number, a hole in a sparse array,
 * an `undefined`) survive rather than being normalized away.
 *
 * A cycle is refused rather than encoded. A value merely reached twice is not
 * a cycle and is not refused, which is the distinction the shared-object cases
 * hold in place.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { hashOf } from "@commonfabric/data-model";
import {
  linkRefFrom,
  linkRefPayload,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { UnknownValue } from "@commonfabric/data-model/codec-common";
import { valueFromDataUri } from "@commonfabric/data-model/codec-data-uri";
import { JsonCodecEngine } from "@commonfabric/data-model/codec-json";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { fromBase64url } from "@commonfabric/utils/base64url";

import { createCell } from "../src/cell.ts";
import { dataUriFromValueWithResolvedLinks } from "../src/data-uri.ts";
import { isSigilLink, type NormalizedLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("data-uri", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    tx.abort();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("dataUriFromValueWithResolvedLinks", () => {
    it("should throw on circular data", () => {
      const circular: any = { name: "test" };
      circular.self = circular;

      expect(() => dataUriFromValueWithResolvedLinks(circular)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should throw on nested circular data", () => {
      const obj1: any = { name: "obj1" };
      const obj2: any = { name: "obj2", ref: obj1 };
      obj1.ref = obj2;

      expect(() => dataUriFromValueWithResolvedLinks(obj1)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should throw on circular data in arrays", () => {
      const circular: any = { items: [] };
      circular.items.push(circular);

      expect(() => dataUriFromValueWithResolvedLinks(circular)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should rewrite relative links with base id", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const baseId = baseCell.getAsNormalizedFullLink().id;

      const relativeLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
          },
        },
      };

      const dataURI = dataUriFromValueWithResolvedLinks(
        { link: relativeLink },
        baseCell,
      );

      // Decode the data URI using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

      expect(parsed.link["/"][LINK_V1_TAG].path).toEqual([
        "nested",
        "value",
      ]);
      expect(parsed.link["/"][LINK_V1_TAG].id).toBe(baseId);
    });

    it("should rewrite relative links with base scope", () => {
      const baseCell = runtime.getCell(space, "scoped base", undefined, tx);
      const scopedBaseCell = createCell(runtime, {
        ...baseCell.getAsNormalizedFullLink(),
        scope: "session",
      }, tx);
      const baseId = scopedBaseCell.getAsNormalizedFullLink().id;

      const relativeLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
          },
        },
      };

      const dataURI = dataUriFromValueWithResolvedLinks(
        { link: relativeLink },
        scopedBaseCell,
      );
      const parsed = valueFromDataUri(dataURI);

      expect(parsed.link["/"][LINK_V1_TAG].id).toBe(baseId);
      expect(parsed.link["/"][LINK_V1_TAG].scope).toBe("session");
    });

    it("should rewrite nested relative links with base id", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const baseId = baseCell.getAsNormalizedFullLink().id;

      const data = {
        items: [
          {
            "/": {
              [LINK_V1_TAG]: {
                path: ["item", "0"],
              },
            },
          },
          {
            nested: {
              link: {
                "/": {
                  [LINK_V1_TAG]: {
                    path: ["item", "1"],
                  },
                },
              },
            },
          },
        ],
      };

      const dataURI = dataUriFromValueWithResolvedLinks(data, baseCell);

      // Decode the data URI using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

      expect(parsed.items[0]["/"][LINK_V1_TAG].id).toBe(baseId);
      expect(parsed.items[1].nested.link["/"][LINK_V1_TAG].id).toBe(
        baseId,
      );
    });

    it("should not modify absolute links", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const otherCell = runtime.getCell(space, "other", undefined, tx);
      const otherId = otherCell.getAsNormalizedFullLink().id;

      const absoluteLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: otherId,
            path: ["some", "path"],
          },
        },
      };

      const dataURI = dataUriFromValueWithResolvedLinks(
        { link: absoluteLink },
        baseCell,
      );

      // Decode the data URI using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

      // Should remain unchanged
      expect(parsed.link["/"][LINK_V1_TAG].id).toBe(otherId);
      expect(parsed.link["/"][LINK_V1_TAG].path).toEqual([
        "some",
        "path",
      ]);
    });

    it("should handle reused acyclic objects without throwing", () => {
      const sharedObject = { value: 42 };
      const data = {
        first: sharedObject,
        second: sharedObject,
        nested: {
          third: sharedObject,
        },
      };

      // Should not throw even though sharedObject is referenced multiple times
      const dataURI = dataUriFromValueWithResolvedLinks(data);

      // Decode and verify using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

      expect(parsed.first.value).toBe(42);
      expect(parsed.second.value).toBe(42);
      expect(parsed.nested.third.value).toBe(42);
    });

    it("should handle UTF-8 characters (emojis, special characters)", () => {
      const data = {
        emoji: "🚀 Hello World! 🌍",
        chinese: "你好世界",
        arabic: "مرحبا بالعالم",
        special: "Ñoño™©®",
        mixed: "Test 🎉 with ñ and 中文",
      };

      // Should not throw with UTF-8 characters
      const dataURI = dataUriFromValueWithResolvedLinks(data);

      // Decode and verify using valueFromDataUri
      const parsed = valueFromDataUri(dataURI);

      expect(parsed.emoji).toBe("🚀 Hello World! 🌍");
      expect(parsed.chinese).toBe("你好世界");
      expect(parsed.arabic).toBe("مرحبا بالعالم");
      expect(parsed.special).toBe("Ñoño™©®");
      expect(parsed.mixed).toBe("Test 🎉 with ñ and 中文");
    });

    it("mints the data-cell media type and the standard encoding", () => {
      const dataURI = dataUriFromValueWithResolvedLinks({ x: 1 });
      // Deliberately a literal (not the imported constant): changing the
      // minted media type must be a conscious test change.
      expect(dataURI.startsWith("data:application/vnd.common-fabric.data,"))
        .toBe(true);
      const payload = new TextDecoder().decode(
        fromBase64url(dataURI.slice(dataURI.indexOf(",") + 1)),
      );
      expect(JsonCodecEngine.seemsLikeEncoded(payload)).toBe(true);
    });

    it("mints the same URI regardless of key insertion order", () => {
      // The standard encoding canonicalizes key order, so the minted id is a
      // function of content alone. This is the property whose absence #4360
      // worked around in `schema-intern.ts`.

      const inOrder = { alpha: 1, beta: [2, 3], gamma: { delta: 4 } };
      const scrambled = { gamma: { delta: 4 }, beta: [2, 3], alpha: 1 };
      expect(dataUriFromValueWithResolvedLinks(scrambled)).toBe(
        dataUriFromValueWithResolvedLinks(inOrder),
      );
    });

    it("preserves non-finite numbers and negative zero", () => {
      const dataURI = dataUriFromValueWithResolvedLinks({
        n: NaN,
        z: -0,
        i: -Infinity,
      });
      const parsed = valueFromDataUri(dataURI);
      expect(Object.is(parsed.n, NaN)).toBe(true);
      expect(Object.is(parsed.z, -0)).toBe(true);
      expect(Object.is(parsed.i, -Infinity)).toBe(true);
    });

    it("round-trips an `undefined` value", () => {
      // `undefined` is a `FabricValue` and round-trips as itself; the
      // present-`undefined` document property is the reader's synthesis
      // (see attestation `load()`), not part of the payload.

      expect(valueFromDataUri(dataUriFromValueWithResolvedLinks(undefined)))
        .toBeUndefined();
    });

    it("keeps the holes in a sparse array that also holds a link", () => {
      // The walk rebuilds a container only when something under it was
      // rewritten. A sparse array holding a link takes that branch, and the
      // holes have to survive it.

      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const sparse: unknown[] = [];
      sparse[0] = { "/": { [LINK_V1_TAG]: { path: ["item"] } } };
      sparse[3] = "after the gap";

      const parsed = valueFromDataUri(
        dataUriFromValueWithResolvedLinks(sparse as any, baseCell),
      );

      expect(parsed.length).toBe(4);
      expect(1 in parsed).toBe(false);
      expect(2 in parsed).toBe(false);
      expect(parsed[3]).toBe("after the gap");
    });

    it("keeps the siblings of a rewritten link untouched", () => {
      // The same rebuilding branch, pinning the other thing it has to carry
      // across: every sibling of the member that changed.

      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const baseId = baseCell.getAsNormalizedFullLink().id;
      const data = {
        before: { deep: [1, 2, { three: true }] },
        link: { "/": { [LINK_V1_TAG]: { path: ["item"] } } },
        after: "unchanged",
      };

      const parsed = valueFromDataUri(
        dataUriFromValueWithResolvedLinks(data, baseCell),
      );

      expect(parsed.link["/"][LINK_V1_TAG].id).toBe(baseId);
      expect(parsed.before).toEqual({ deep: [1, 2, { three: true }] });
      expect(parsed.after).toBe("unchanged");
    });

    it("refuses a value that no codec can represent", () => {
      // A value with no fabric representation reaches the encoder as it came
      // in, rather than being emptied out into a plain object on the way.

      expect(() =>
        dataUriFromValueWithResolvedLinks({ when: new Date() } as any)
      )
        .toThrow(/no applicable codec/);
    });

    it("represents a `FabricPrimitive` leaf correctly", () => {
      const h = hashOf({ some: "value" });
      const parsed = valueFromDataUri(dataUriFromValueWithResolvedLinks({ h }));
      expect(parsed.h).toBeInstanceOf(FabricHash);
      expect(parsed.h.toString()).toBe(h.toString());
    });

    it("represents a link-free `FabricInstance` via its codec", () => {
      // Link-free content on purpose: for an instance whose state carries no
      // links, today's pass-through and the eventual traverse-into-state
      // behavior (see the `TODO` in the walk) coincide, so this pins only the
      // codec round-trip, not the pass-through itself.

      const inst = new UnknownValue("Zzz@1", { a: 1 });
      const parsed = valueFromDataUri(
        dataUriFromValueWithResolvedLinks({ inst }),
      );
      expect(parsed.inst).toBeInstanceOf(UnknownValue);
      expect(parsed.inst.wireTypeTag).toBe("Zzz@1");
      expect(parsed.inst.state).toEqual({ a: 1 });
    });

    it("rewrites relative links in the modern regime (`FabricLink`)", () => {
      setModernCellRepConfig(true);
      try {
        const baseId = `of:${hashOf({ base: "modern" }).taggedHashString}`;
        const base: NormalizedLink = {
          id: baseId as any,
          space,
          scope: "space",
          path: [],
        };
        const relativeLink = linkRefFrom({ path: ["nested", "value"] });

        const dataURI = dataUriFromValueWithResolvedLinks(
          { link: relativeLink },
          base,
        );
        const parsed = valueFromDataUri(dataURI);

        expect(isSigilLink(parsed.link)).toBe(true);
        const payload = linkRefPayload(parsed.link) as any;
        expect(payload.id).toBe(baseId);
        expect(payload.path).toEqual(["nested", "value"]);
      } finally {
        resetModernCellRepConfig();
      }
    });
  });
});

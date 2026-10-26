import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SchemaPathSelector } from "@commonfabric/api";
import { getContainersHashedForTestingOnly } from "@commonfabric/data-model/for-testing-only";
import { internSchema } from "@commonfabric/data-model-schema";
import type { MIME, URI } from "@commonfabric/memory/interface";

import { watchIdForEntry } from "../src/storage/v2-watch.ts";

describe("v2-watch", () => {
  describe("watchIdForEntry()", () => {
    const address = {
      id: "of:watch-id" as URI,
      type: "application/json" as MIME,
    };
    // The schema is interned, as a selector's is by the time its watch id is
    // asked for; a schema that is not deep-frozen is hashed on each call.
    const selector: SchemaPathSelector = {
      path: ["value", "title"],
      schema: internSchema({
        type: "object",
        properties: { title: { type: "string" } },
      }),
    };

    /** The containers hashed while `body` runs. */
    function containersHashedBy(body: () => void): number {
      const before = getContainersHashedForTestingOnly();
      body();
      return getContainersHashedForTestingOnly() - before;
    }

    it("returns one id for two entries equal by value", () => {
      expect(watchIdForEntry(address, selector, "")).toBe(
        watchIdForEntry(
          { ...address },
          { path: [...selector.path], schema: selector.schema },
          "",
        ),
      );
    });

    it("hashes no container for an entry equal by value to one it has returned an id for", () => {
      watchIdForEntry(address, selector, "");

      expect(containersHashedBy(() => {
        watchIdForEntry(
          { ...address },
          { path: [...selector.path], schema: selector.schema },
          "",
        );
      })).toBe(0);
    });

    it("returns ids that differ for selectors whose paths differ", () => {
      expect(watchIdForEntry(address, selector, "")).not.toBe(
        watchIdForEntry(address, { ...selector, path: ["value"] }, ""),
      );
    });

    it("returns ids that differ for selectors whose schemas differ", () => {
      expect(watchIdForEntry(address, selector, "")).not.toBe(
        watchIdForEntry(address, { ...selector, schema: true }, ""),
      );
    });

    it("returns ids that differ for a selector with a schema and one without", () => {
      expect(watchIdForEntry(address, { path: [], schema: {} }, "")).not.toBe(
        watchIdForEntry(address, { path: [] }, ""),
      );
    });

    it("returns ids that differ for addresses whose scopes differ", () => {
      expect(watchIdForEntry(address, selector, "")).not.toBe(
        watchIdForEntry({ ...address, scope: "user" }, selector, ""),
      );
    });

    it("returns one id for an address naming the space scope and one naming none", () => {
      expect(watchIdForEntry(address, selector, "")).toBe(
        watchIdForEntry({ ...address, scope: "space" }, selector, ""),
      );
    });

    it("returns ids that differ for an address naming a scope key and one naming none", () => {
      expect(watchIdForEntry(address, selector, "")).not.toBe(
        watchIdForEntry(
          { ...address, scopeKey: "user:did:key:z6Mk" },
          selector,
          "",
        ),
      );
    });

    it("returns ids that differ for branches that differ", () => {
      expect(watchIdForEntry(address, selector, "")).not.toBe(
        watchIdForEntry(address, selector, "feature"),
      );
    });

    it("returns ids that differ for documents that differ", () => {
      expect(watchIdForEntry(address, selector, "")).not.toBe(
        watchIdForEntry({ ...address, id: "of:other" as URI }, selector, ""),
      );
    });
  });
});

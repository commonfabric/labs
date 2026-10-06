// Example-based schema tests: field mapping via interim cells, nested sinks
// via asCell, and nested sinks with aliases.

import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Cell, isCell } from "../src/cell.ts";
import { externalRefTo, resolvedSchema } from "./schema-ref-helpers.ts";
import { SigilLink } from "../src/sigil-types.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { toURI } from "../src/uri-utils.ts";
import { parseLink } from "../src/link-utils.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { sortAndCompactPaths } from "../src/reactive-dependencies.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema - Examples", () => {
  // These pins were written against the flag-on writer (reference-form
  // link schemas); the flag's build default is off, so they opt in.
  beforeEach(() => {
    setContentAddressedSchemasConfig(true);
  });
  afterEach(() => {
    resetContentAddressedSchemasConfig();
  });

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
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Examples", () => {
    it("allows mapping of fields via interim cells", () => {
      const c = runtime.getCell<{
        id: number;
        metadata: {
          createdAt: string;
          type: string;
        };
        tags: string[];
      }>(
        space,
        "allows mapping of fields via interim cells 1",
        undefined,
        tx,
      );
      c.set({
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
        tags: ["a", "b"],
      });

      // This is what the system (or someone manually) would create to remap
      // data to match the desired schema
      const mappingCell = runtime.getCell<{
        id: SigilLink;
        changes: SigilLink[];
        kind: SigilLink;
        tag: SigilLink;
      }>(
        space,
        "allows mapping of fields via interim cells 2",
        undefined,
        tx,
      );
      mappingCell.setRaw({
        // as-is
        id: c.key("id").getAsLink(),
        // turn single value to set
        changes: [c.key("metadata").key("createdAt").getAsLink()],
        // rename field and uplift from nested element
        kind: c.key("metadata").key("type").getAsLink(),
        // turn set into a single value
        tag: c.key("tags").key(0).getAsLink(),
      });

      // This schema is how the recipient specifies what they want
      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          changes: { type: "array", items: { type: "string" } },
          kind: { type: "string" },
          tag: { type: "string" },
        },
      } as const satisfies JSONSchema;

      // Let type inference work through the schema
      const result = mappingCell.asSchema(schema).get();

      expect(result).toEqualIgnoringSymbols({
        id: 1,
        changes: ["2025-01-06"],
        kind: "user",
        tag: "a",
      });
    });

    it("should support nested sinks via asCell", async () => {
      const innerCell = runtime.getCell<{ label: string }>(
        space,
        "should support nested sinks 1",
      );
      innerCell.withTx(tx).set({ label: "first" });

      const cell = runtime.getCell<
        { value: string; current: Cell<{ label: string }> }
      >(
        space,
        "should support nested sinks 2",
        {
          type: "object",
          properties: {
            value: { type: "string" },
            current: {
              type: "object",
              properties: { label: { type: "string" } },
              required: ["label"],
              asCell: ["cell"],
            },
          },
          required: ["value", "current"],
        } as const satisfies JSONSchema,
        tx,
      );
      cell.withTx(tx).setRawUntyped({
        value: "root",
        current: innerCell.getAsLink(),
      });

      tx.commit();
      tx = runtime.edit();

      const rootValues: string[] = [];
      const currentValues: string[] = [];
      const currentByKeyValues: string[] = [];
      const currentByGetValues: string[] = [];

      // Nested traversal of data
      const cancel = cell.sink((value) => {
        rootValues.push(value.value);
        const cancel = value.current.sink((value) => {
          currentValues.push(value.label);
        });
        return () => {
          rootValues.push("cancelled");
          cancel();
        };
      });

      // Querying for a value tied to the currently selected sub-document
      cell.key("current")
        .key("label")
        .sink((value) => {
          currentByKeyValues.push(value as unknown as string);
        });

      // .get() the currently selected cell
      cell.key("current")
        .get()
        .sink((value) => {
          currentByGetValues.push(value.label);
        });

      await runtime.idle();

      // Find the currently selected cell and update it
      const first = cell.key("current").get();
      expect(first.getAsNormalizedFullLink().id).toEqual(
        innerCell.getAsNormalizedFullLink().id,
      );
      expect(first.getAsNormalizedFullLink().path).toEqual([]);
      expect(isCell(first)).toBe(true);
      expect(first.get()).toEqualIgnoringSymbols({ label: "first" });
      first.withTx(tx).set({ label: "first - update" });

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();
      // TODO(@ubik2) - investigate why our currentValues now has "first-update"
      // twice instead of just once

      // Now change the currently selected cell
      const second = runtime.getCell(
        space,
        "should support nested sinks 3",
        {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        } as const satisfies JSONSchema,
        tx,
      );
      second.withTx(tx).set({ label: "second" });
      cell.withTx(tx).key("current").set(second);

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      // Now change the first one again, should only change currentByGetValues
      first.withTx(tx).set({ label: "first - updated again" });

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      // Now change the second one, should change all but currentByGetValues
      second.withTx(tx).set({ label: "second - update" });

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(currentByGetValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "first - updated again",
      ]);
      expect(currentByKeyValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "second",
        "second - update",
      ]);
      expect(currentValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "second",
        "second - update",
      ]);
      expect(rootValues).toEqualIgnoringSymbols([
        "root",
        "cancelled",
        "root",
      ]);

      cancel();

      expect(rootValues).toEqualIgnoringSymbols([
        "root",
        "cancelled",
        "root",
        "cancelled",
      ]);
    });

    it("should support nested sinks via asCell with aliases", async () => {
      // We get this case in VDOM. There is an alias to a cell with a reference
      // to the actual data, and that reference is updated. So it's similar to
      // the previous example, but the updating happens behind an alias,
      // typically by another actor.

      const schema = {
        type: "object",
        properties: {
          value: { type: "string" },
          current: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
            asCell: ["cell"],
          },
        },
        required: ["value", "current"],
      } as const satisfies JSONSchema;

      // Construct an alias that also has a path to the actual data
      // "of:baedreifart2svf2yub6i73lfbv3foslfnnqkby6wbzyefhkxn3bfyjkbmi"
      const initial = runtime.getCell<{ foo: { label: string } }>(
        space,
        "should support nested sinks via asCell with aliases 1",
      );
      initial.withTx(tx).set({ foo: { label: "first" } });
      const initialEntityId = initial.entityId!;

      // "of:baedreiaumqclqrv3snkr57vua6gwe3jtvo6syvcekc3vw5wl52mh7nlop4"
      const linkCell = runtime.getCell<any>(
        space,
        "should support nested sinks via asCell with aliases 2",
      );
      linkCell.withTx(tx).setRaw(initial.getAsLink());
      const linkEntityId = linkCell.entityId!;

      // "of:baedreibxsezekir5bvzaf2cut4n2g6xvrpbnre7n77dtgi64ktfdbelavu"
      const docCell = runtime.getCell<{
        value: string;
        current: any;
      }>(
        space,
        "should support nested sinks via asCell with aliases 3",
      );
      docCell.withTx(tx).setRaw({
        value: "root",
        current: linkCell.key("foo").getAsWriteRedirectLink(),
      });

      tx.commit();
      tx = runtime.edit();

      const root = docCell.asSchema<
        { value: string; current: Cell<{ label: string }> }
      >(schema);

      const rootValues: any[] = [];
      const currentValues: any[] = [];
      const currentByKeyValues: any[] = [];
      const currentByGetValues: any[] = [];

      // Nested traversal of data
      root.sink((value) => {
        rootValues.push(value.value);
        const cancel = value.current.sink((value: { label: string }) => {
          currentValues.push(value.label);
        });
        return () => {
          rootValues.push("cancelled");
          cancel();
        };
      });

      // Querying for a value tied to the currently selected sub-document
      const current = root.key("current").key("label");
      current.sink((value) => {
        currentByKeyValues.push(value as unknown as string);
      });

      // Make sure the schema is correct and it is still anchored at the root
      expect(resolvedSchema(current.schema)).toEqual({ type: "string" });
      // parseLink of a serialized sigil stamps the read-side data-derived
      // mark (OW51's `viaLinkHop`).
      expect(parseLink(current.getAsLink({ includeSchema: true }))).toEqual({
        id: toURI(docCell.entityId!),
        path: ["current", "label"],
        space,
        scope: "space",
        schema: externalRefTo({ type: "string" }),
        viaLinkHop: true,
      });

      // .get() the currently selected cell. This should not change when
      // the currently selected cell changes!
      root
        .key("current")
        .get()
        .sink((value: { label: string }) => {
          currentByGetValues.push(value.label);
        });

      await runtime.idle();

      // Find the currently selected cell and read it
      const first = root.key("current").withTx(tx).get();
      // current is pointing to linkCell, which is pointing to initial
      expect(first.getAsNormalizedFullLink().id).toEqual(
        initial.getAsNormalizedFullLink().id,
      );
      expect(first.getAsNormalizedFullLink().path).toEqual(["foo"]);
      expect(isCell(first)).toBe(true);
      expect(first.get()).toEqualIgnoringSymbols({ label: "first" });
      const { asCell: _ignore, ...omitSchema } = schema.properties.current;
      // Same stamp on this serialized-sigil parse (OW51 `viaLinkHop`).
      expect(parseLink(first.getAsLink({ includeSchema: true }))).toEqual({
        id: toURI(initialEntityId),
        path: ["foo"],
        space,
        scope: "space",
        schema: externalRefTo(omitSchema),
        viaLinkHop: true,
      });
      const log = txToReactivityLog(tx);
      const reads = sortAndCompactPaths(log.reads);
      // Per-path reads: link resolution reads are now non-scheduling,
      // only sigil probe reads and fine-grained traversal reads remain.
      // The linkEntity has probe reads at sigil sub-paths.
      expect(
        reads.some((r) => r.id === toURI(linkEntityId)),
      ).toBe(true);
      // The docCell has a probe read at the "current" sub-path.
      expect(
        reads.some((r) =>
          r.id === toURI(docCell.entityId!) &&
          r.path[0] === "value" && r.path[1] === "current"
        ),
      ).toBe(true);
      // The initial entity is read via followPointer at the "foo" sub-path.
      expect(
        reads.some((r) =>
          r.id === toURI(initialEntityId) &&
          r.path[0] === "value" && r.path[1] === "foo"
        ),
      ).toBe(true);

      // Then update it
      initial.withTx(tx).set({ foo: { label: "first - update" } });
      tx.commit();
      tx = runtime.edit();

      await runtime.idle();
      expect(first.get()).toEqualIgnoringSymbols({
        label: "first - update",
      });

      // Now change the currently selected cell behind the alias. This should
      // trigger a change on the root cell, since this is the first doc after
      // the aliases.
      const second = runtime.getCell<{ foo: { label: string } }>(
        space,
        "should support nested sinks via asCell with aliases 4",
      );
      second.withTx(tx).set({ foo: { label: "second" } });
      linkCell.withTx(tx).setRaw(second.getAsLink());

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(rootValues).toEqual([
        "root",
        "cancelled",
        "root",
      ]);

      // Change unrelated value should update root, but not the other cells
      root.withTx(tx).key("value").set("root - updated");
      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(rootValues).toEqual([
        "root",
        "cancelled",
        "root",
        "cancelled",
        "root - updated",
      ]);

      // Now change the first one again, should only change currentByGetValues
      initial.withTx(tx).set({ foo: { label: "first - updated again" } });
      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      // Now change the second one, should change all but currentByGetValues
      second.withTx(tx).set({ foo: { label: "second - update" } });
      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(rootValues).toEqualIgnoringSymbols([
        "root",
        "cancelled",
        "root",
        "cancelled",
        "root - updated",
      ]);

      // Now change the alias. This should also be seen by the root cell. It
      // will not be seen by the .get()s earlier, since they anchored on the
      // link, not the alias ahead of it. That's intentional.
      const third = runtime.getCell<{ label: string }>(
        space,
        "should support nested sinks via asCell with aliases 5",
      );
      third.withTx(tx).set({ label: "third" });
      docCell.withTx(tx).key("current").setRaw(third.getAsWriteRedirectLink());

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      // Now change the first one again, should only change currentByGetValues
      initial.withTx(tx).set({ foo: { label: "first - updated yet again" } });
      second.withTx(tx).set({ foo: { label: "second - updated again" } });
      third.withTx(tx).set({ label: "third - updated" });

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(currentByGetValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "first - updated again",
        "first - updated yet again",
      ]);
      expect(currentByKeyValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "second",
        "second - update",
        "third",
        "third - updated",
      ]);
      expect(currentValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "second", // That was changing `value` on root
        "second",
        "second - update",
        "third",
        "third - updated",
      ]);
      expect(rootValues).toEqualIgnoringSymbols([
        "root",
        "cancelled",
        "root",
        "cancelled",
        "root - updated",
        "cancelled",
        "root - updated",
      ]);
    });
  });
});

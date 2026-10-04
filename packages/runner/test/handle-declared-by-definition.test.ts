/**
 * A handle declared on a definition — `asCell` on the `$defs` entry a position
 * names by `$ref`, as the generator emits for a named type that is itself a
 * `Cell<…>` — read the way the same handle written at the reference reads. Each
 * case stores one value, reads it through both spellings, and holds the
 * definition's reading to the reference's: the value returned, and the reads
 * the transaction records for conflicts and for reactivity. The reference's
 * reading is pinned as well, so the two cannot agree by failing together.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { isCell } from "../src/cell.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { SchemaObjectTraverser } from "../src/traverse.ts";

const signer = await Identity.fromPassphrase("handle-declared-by-definition");
const space = signer.did();

const profileBody = {
  type: "object",
  properties: { name: { type: "string" } },
} as const satisfies JSONSchema;

/** One way of writing the handle a position declares. */
interface Spelling {
  /** The schema at the position. */
  readonly position: JSONSchema;

  /** The `$defs` the position's reference resolves against. */
  readonly $defs: Record<string, JSONSchema>;
}

/** The handle written at the reference. */
const atReference: Spelling = {
  position: { $ref: "#/$defs/Profile", asCell: ["cell"] },
  $defs: { Profile: profileBody },
};

/** The same handle declared by the definition the reference names. */
const byDefinition: Spelling = {
  position: { $ref: "#/$defs/Profile" },
  $defs: { Profile: { ...profileBody, asCell: ["cell"] } },
};

const titledBody = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
} as const satisfies JSONSchema;

/** A union of two handles, each written at its reference. */
const unionAtReferences: Spelling = {
  position: {
    anyOf: [
      { $ref: "#/$defs/Profile", asCell: ["cell"] },
      { $ref: "#/$defs/Titled", asCell: ["cell"] },
    ],
  },
  $defs: { Profile: profileBody, Titled: titledBody },
};

/** The same union, each handle declared by the definition it names. */
const unionByDefinitions: Spelling = {
  position: {
    anyOf: [{ $ref: "#/$defs/Profile" }, { $ref: "#/$defs/Titled" }],
  },
  $defs: {
    Profile: { ...profileBody, asCell: ["cell"] },
    Titled: { ...titledBody, asCell: ["cell"] },
  },
};

/** An object branch selected by `kind`, holding `profile` when given one. */
function branch(kind: string, profile?: JSONSchema): JSONSchema {
  return {
    type: "object",
    properties: {
      kind: { type: "string", const: kind },
      ...(profile === undefined ? {} : { profile }),
    },
    required: ["kind"],
  };
}

/** The schema for `{ kind, profile }`, as one object or as a union branch. */
function profileHolder(spelling: Spelling, union: boolean): JSONSchema {
  const object = branch("a", spelling.position);
  return union
    ? { $defs: spelling.$defs, anyOf: [object, branch("b")] }
    : { $defs: spelling.$defs, ...(object as object) };
}

/**
 * The schema for `{ inner: { profile } }`, where `inner` is only `type` and
 * `properties`, the shape the traversal's plain-schema path takes, and the
 * definitions sit at the root.
 */
function nestedProfileHolder(spelling: Spelling): JSONSchema {
  return {
    $defs: spelling.$defs,
    type: "object",
    properties: {
      inner: { type: "object", properties: { profile: spelling.position } },
    },
  };
}

/** The schema for `{ profiles }`, an array of the position. */
function profileList(spelling: Spelling): JSONSchema {
  return {
    $defs: spelling.$defs,
    type: "object",
    properties: { profiles: { type: "array", items: spelling.position } },
  };
}

describe("handle declared by a definition", () => {
  for (const lazy of [false, true]) {
    describe(lazy ? "read lazily" : "read eagerly", () => {
      let storageManager: ReturnType<typeof StorageManager.emulate>;
      let runtime: Runtime;
      let documents: Map<string, string>;

      beforeEach(() => {
        storageManager = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        documents = new Map();
      });

      afterEach(async () => {
        await runtime.dispose();
        await storageManager.close();
      });

      /**
       * Stores `{ name }` in a document of its own, and returns a link to it.
       * Its reads and handles are reported under `label`.
       */
      async function storedProfile(cause: string, label: string) {
        const tx = runtime.edit();
        const cell = runtime.getCell(space, cause, undefined, tx);
        cell.setRaw({ name: label });
        await tx.commit();
        documents.set(cell.getAsNormalizedFullLink().id, label);
        return cell.getAsLink();
      }

      /** Names a document by its label, the holder being `holder`. */
      function documentLabel(id: string): string {
        return documents.get(id) ?? "holder";
      }

      /**
       * Stores `value` in the holder `cause`, reads it back through `schema`
       * with `read`, and reports what the read returned and what its
       * transaction recorded.
       */
      async function observe(
        cause: string,
        value: unknown,
        schema: JSONSchema,
        read: (holder: { get(): unknown; key(k: string): unknown }) => unknown,
      ) {
        const write = runtime.edit();
        runtime.getCell(space, cause, undefined, write).setRaw(value as never);
        await write.commit();

        const tx = runtime.edit();
        tx.markLazyMaterialize(lazy);
        const holder = runtime.getCell(space, cause, schema, tx);
        const project = (result: unknown): unknown => {
          if (Array.isArray(result)) return result.map(project);
          if (!isCell(result)) return result;
          const link = result.getAsNormalizedFullLink();
          return { handle: documentLabel(link.id), path: link.path };
        };
        const returned = project(read(holder as never));
        const replica = storageManager.open(space).replica as SpaceReplica;
        const label = (read: { id: string; path: readonly string[] }) =>
          `${documentLabel(read.id)}/${read.path.join(".")}`;
        const conflict = replica.accessForTestingOnly.buildReads(tx.tx, 1)
          .confirmed.map(label);
        const reactive = txToReactivityLog(tx).reads.map(label);
        tx.abort();
        return {
          returned,
          conflict: [...new Set(conflict)].sort(),
          reactive: [...new Set(reactive)].sort(),
        };
      }

      for (const union of [false, true]) {
        const where = union ? " in a union branch" : "";

        it(`reads a linked property${where} as a handle on the document it names`, async () => {
          const profile = await storedProfile("linked-profile", "Ada");
          const read = (holder: { get(): unknown }) =>
            (holder.get() as { profile: unknown }).profile;

          const expected = await observe(
            "at-reference",
            { kind: "a", profile },
            profileHolder(atReference, union),
            read,
          );
          expect(expected.returned).toEqual({ handle: "Ada", path: [] });
          expect(
            await observe(
              "by-definition",
              { kind: "a", profile },
              profileHolder(byDefinition, union),
              read,
            ),
          ).toEqual(expected);
        });

        it(`reads an inline property${where} as a handle without reading into it`, async () => {
          const read = (holder: { get(): unknown }) =>
            (holder.get() as { profile: unknown }).profile;

          const expected = await observe(
            "at-reference",
            { kind: "a", profile: { name: "Ada" } },
            profileHolder(atReference, union),
            read,
          );
          expect(expected.returned).toEqual({
            handle: "holder",
            path: ["profile"],
          });
          expect(
            await observe(
              "by-definition",
              { kind: "a", profile: { name: "Ada" } },
              profileHolder(byDefinition, union),
              read,
            ),
          ).toEqual(expected);
        });
      }

      it("reads a linked property under an object of only `type` and `properties` as a handle", async () => {
        // The root's definitions reach `profile` through `inner`, a schema
        // that on its own carries no `$defs` for the reference to resolve in.

        const profile = await storedProfile("nested-profile", "Ada");
        const read = (holder: { get(): unknown }) =>
          (holder.get() as { inner: { profile: unknown } }).inner.profile;

        const expected = await observe(
          "at-reference",
          { inner: { profile } },
          nestedProfileHolder(atReference),
          read,
        );
        expect(expected.returned).toEqual({ handle: "Ada", path: [] });
        expect(
          await observe(
            "by-definition",
            { inner: { profile } },
            nestedProfileHolder(byDefinition),
            read,
          ),
        ).toEqual(expected);
      });

      it("reads a linked property typed as a union of handle definitions as the reference-site union does", async () => {
        const profile = await storedProfile("union-profile", "Ada");
        const read = (holder: { get(): unknown }) =>
          (holder.get() as { profile: unknown }).profile;

        const expected = await observe(
          "at-references",
          { kind: "a", profile },
          profileHolder(unionAtReferences, false),
          read,
        );
        expect(expected.returned).toEqual({ handle: "Ada", path: [] });
        expect(
          await observe(
            "by-definitions",
            { kind: "a", profile },
            profileHolder(unionByDefinitions, false),
            read,
          ),
        ).toEqual(expected);
      });

      it("reads an inline property typed as a union of handle definitions as the reference-site union does", async () => {
        // No option declares the handle at the position's root, so the
        // union's branches are traversed and their merge mints it.

        const read = (holder: { get(): unknown }) =>
          (holder.get() as { profile: unknown }).profile;

        const expected = await observe(
          "at-references",
          { kind: "a", profile: { name: "Ada" } },
          profileHolder(unionAtReferences, false),
          read,
        );
        expect(expected.returned).toEqual({
          handle: "holder",
          path: ["profile"],
        });
        expect(
          await observe(
            "by-definitions",
            { kind: "a", profile: { name: "Ada" } },
            profileHolder(unionByDefinitions, false),
            read,
          ),
        ).toEqual(expected);
      });

      it("reads linked array elements as handles on the documents they name", async () => {
        const profiles = [
          await storedProfile("first-profile", "Ada"),
          await storedProfile("second-profile", "Grace"),
        ];
        const read = (holder: { get(): unknown }) =>
          (holder.get() as { profiles: unknown }).profiles;

        const expected = await observe(
          "at-reference",
          { profiles },
          profileList(atReference),
          read,
        );
        expect(expected.returned).toEqual([
          { handle: "Ada", path: [] },
          { handle: "Grace", path: [] },
        ]);
        expect(
          await observe(
            "by-definition",
            { profiles },
            profileList(byDefinition),
            read,
          ),
        ).toEqual(expected);
      });

      if (!lazy) {
        it("resolves at most two references for each linked element it reads as a handle", async () => {
          // Every handle an eager read reaches is asked whether it declares
          // the handle at its root. One declared there is answered without
          // resolving its reference, which the rest of the read resolves
          // under two times per element.

          const resolutions = async (count: number) => {
            const profile = await storedProfile(`profile-${count}`, "Ada");
            const write = runtime.edit();
            runtime.getCell(space, `holder-${count}`, undefined, write).setRaw(
              {
                profiles: Array.from({ length: count }, () => profile),
              } as never,
            );
            await write.commit();
            const tx = runtime.edit();
            tx.markLazyMaterialize(false);
            using resolve = spy(ContextualFlowControl, "resolveSchemaRefs");
            const holder = runtime.getCell(
              space,
              `holder-${count}`,
              profileList(atReference),
              tx,
            );
            expect((holder.get() as { profiles: unknown[] }).profiles.length)
              .toBe(count);
            tx.abort();
            return resolve.calls.length;
          };

          const few = await resolutions(25);
          const many = await resolutions(50);
          expect(many - few).toBeLessThanOrEqual(2 * 25);
        });
      }

      it("reads linked array elements typed as a union of handle definitions as the reference-site union does", async () => {
        const profiles = [
          await storedProfile("first-union-profile", "Ada"),
          await storedProfile("second-union-profile", "Grace"),
        ];
        const read = (holder: { get(): unknown }) =>
          (holder.get() as { profiles: unknown }).profiles;

        const expected = await observe(
          "at-references",
          { profiles },
          profileList(unionAtReferences),
          read,
        );
        expect(expected.returned).toEqual([
          { handle: "Ada", path: [] },
          { handle: "Grace", path: [] },
        ]);
        // Reading a target to mint its handle does not make the holder
        // depend on what the target holds.
        expect(expected.conflict).not.toContain("Ada/value.name");
        expect(
          await observe(
            "by-definitions",
            { profiles },
            profileList(unionByDefinitions),
            read,
          ),
        ).toEqual(expected);
      });

      it("reads inline array elements typed as a union of handle definitions as the reference-site union does", async () => {
        const read = (holder: { get(): unknown }) =>
          (holder.get() as { profiles: unknown }).profiles;

        const expected = await observe(
          "at-references",
          { profiles: [{ name: "Ada" }] },
          profileList(unionAtReferences),
          read,
        );
        expect(expected.returned).toEqual([
          { handle: "holder", path: ["profiles", "0"] },
        ]);
        expect(
          await observe(
            "by-definitions",
            { profiles: [{ name: "Ada" }] },
            profileList(unionByDefinitions),
            read,
          ),
        ).toEqual(expected);
      });
    });
  }

  describe("SchemaObjectTraverser.hasAsCell()", () => {
    it("returns `true` for a union of references to handle definitions, as for the union with `asCell` at each reference", () => {
      const union = (spelling: Spelling) => ({
        ...(spelling.position as object),
        $defs: spelling.$defs,
      });

      expect(SchemaObjectTraverser.hasAsCell(union(unionAtReferences))).toBe(
        true,
      );
      expect(SchemaObjectTraverser.hasAsCell(union(unionByDefinitions))).toBe(
        true,
      );
    });

    it("returns `false` for a union that reaches itself through its only option", () => {
      // Nothing declares a handle here except by way of the union itself, so
      // reading the option again proves nothing.

      expect(
        SchemaObjectTraverser.hasAsCell({
          $ref: "#/$defs/R",
          $defs: { R: { anyOf: [{ $ref: "#/$defs/R" }] } },
        }),
      ).toBe(false);
    });

    it("returns `true` for a union whose option declares a handle only once a union read further up is found to", () => {
      // `R` is `M` or `W`, and `W` is `M` alone. Reading `M`'s options
      // reaches `W` through `P` while `M` is still being read, and takes `M`
      // there as declaring no handle. `P` declares one through its `oneOf`
      // all the same, so `M` does, and then so do `W` and `R`.

      expect(
        SchemaObjectTraverser.hasAsCell({
          $ref: "#/$defs/R",
          $defs: {
            H: { type: "string", asCell: ["cell"] },
            R: { anyOf: [{ $ref: "#/$defs/M" }, { $ref: "#/$defs/W" }] },
            M: { anyOf: [{ $ref: "#/$defs/P" }, { $ref: "#/$defs/H" }] },
            P: {
              anyOf: [{ $ref: "#/$defs/W" }],
              oneOf: [{ $ref: "#/$defs/H" }],
            },
            W: { anyOf: [{ $ref: "#/$defs/M" }] },
          },
        }),
      ).toBe(true);
    });

    it("returns `false` for a union whose options read one list against two definition maps", () => {
      // The union has no definitions to hand its options, so each option
      // reads `A` against its own, and both maps name one list, which reaches
      // itself under each. The list is read to a verdict once under each map,
      // and the reading settles. One that did not settle would resolve
      // without end, which the stub turns into a failure.

      const list = [{ $ref: "#/$defs/X" }, { $ref: "#/$defs/H" }];
      const definitions = () => ({
        A: { anyOf: list },
        X: { anyOf: [{ $ref: "#/$defs/A" }], oneOf: [{ $ref: "#/$defs/H" }] },
        H: { type: "string", asCell: ["cell"] },
      });
      const resolve = ContextualFlowControl.resolveSchemaRefs;
      let resolutions = 0;
      using _bounded = stub(
        ContextualFlowControl,
        "resolveSchemaRefs",
        (...args: Parameters<typeof resolve>) => {
          if (++resolutions > 1000) {
            throw new Error("the reading did not settle");
          }
          return resolve.apply(ContextualFlowControl, args);
        },
      );

      expect(
        SchemaObjectTraverser.hasAsCell({
          anyOf: [
            { $ref: "#/$defs/A", $defs: definitions() },
            { $ref: "#/$defs/A", $defs: definitions() },
            { type: "string" },
          ],
        } as JSONSchema),
      ).toBe(false);
    });

    it("resolves each reference at most twice for definitions that each name the next two", () => {
      // Every definition but the first two is reached from the two before
      // it, so reading each path to it anew resolves exponentially often.

      const count = 24;
      const ref = (i: number) => ({ $ref: `#/$defs/R${i}` });
      const $defs = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `R${i}`,
          i >= count - 2
            ? { type: "string", asCell: ["cell"] }
            : { anyOf: [ref(i + 1), ref(i + 2)] },
        ]),
      );
      const references = 1 + 2 * (count - 2);
      using resolve = spy(ContextualFlowControl, "resolveSchemaRefs");

      expect(
        SchemaObjectTraverser.hasAsCell({ ...ref(0), $defs } as JSONSchema),
      ).toBe(true);
      expect(resolve.calls.length).toBeLessThanOrEqual(2 * references);
    });
  });
});

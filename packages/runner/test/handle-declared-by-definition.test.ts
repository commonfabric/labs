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

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";

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
    });
  }
});

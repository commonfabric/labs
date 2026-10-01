/**
 * A position typed as a union of handles, read the way the same position typed
 * as a single handle reads: the reads the transaction records as commit
 * conflicts are the single handle's, eagerly and lazily. Deciding which branch
 * mints the handle resolves a reference; it consumes no value, so a writer to
 * what the handle points at does not conflict with the reader holding it. A
 * union with a branch read as a value is the exception: its reads decide what
 * the reader holds, and they stay.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../src/builder/types.ts";
import { type Cell, isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("union-of-handles-conflict-reads");
const space = signer.did();

const $defs = {
  Profile: { type: "object", properties: { name: { type: "string" } } },
  Titled: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
} as const satisfies Record<string, JSONSchema>;

/** A handle on a profile. */
const singleHandle = {
  $ref: "#/$defs/Profile",
  asCell: ["cell"],
} as const satisfies JSONSchema;

/** A handle on a profile or on a titled document. */
const unionOfHandles = {
  anyOf: [
    { $ref: "#/$defs/Profile", asCell: ["cell"] },
    { $ref: "#/$defs/Titled", asCell: ["cell"] },
  ],
} as const satisfies JSONSchema;

/**
 * A handle on a profile, or a titled object read as a value: which branch
 * applies turns on whether the document carries a `title`.
 */
const handleOrValue = {
  anyOf: [
    { $ref: "#/$defs/Profile", asCell: ["cell"] },
    {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  ],
} as const satisfies JSONSchema;

/** The schema for `{ profile }`. */
function holderOf(position: JSONSchema): JSONSchema {
  return { $defs, type: "object", properties: { profile: position } };
}

/** The schema for `{ profiles }`, an array of the position. */
function listOf(position: JSONSchema): JSONSchema {
  return {
    $defs,
    type: "object",
    properties: { profiles: { type: "array", items: position } },
  };
}

/** Where the handle sits in the holder, and how it is stored there. */
interface Placement {
  readonly name: string;
  readonly linked: boolean;
  readonly schema: (position: JSONSchema) => JSONSchema;
  readonly value: (profile: unknown) => unknown;
  readonly handle: (holder: unknown) => unknown;
}

const placements: readonly Placement[] = [
  {
    name: "an inline property",
    linked: false,
    schema: holderOf,
    value: () => ({ profile: { name: "Ada" } }),
    handle: (holder) => (holder as { profile: unknown }).profile,
  },
  {
    name: "a linked property",
    linked: true,
    schema: holderOf,
    value: (profile) => ({ profile }),
    handle: (holder) => (holder as { profile: unknown }).profile,
  },
  {
    name: "an inline array element",
    linked: false,
    schema: listOf,
    value: () => ({ profiles: [{ name: "Ada" }] }),
    handle: (holder) => (holder as { profiles: unknown[] }).profiles[0],
  },
  {
    name: "a linked array element",
    linked: true,
    schema: listOf,
    value: (profile) => ({ profiles: [profile] }),
    handle: (holder) => (holder as { profiles: unknown[] }).profiles[0],
  },
];

describe("union-of-handles-conflict-reads", () => {
  for (const lazy of [false, true]) {
    describe(lazy ? "read lazily" : "read eagerly", () => {
      describe("the reads a transaction records", () => {
        let storageManager: ReturnType<typeof StorageManager.emulate>;
        let runtime: Runtime;

        beforeEach(() => {
          storageManager = StorageManager.emulate({ as: signer });
          runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager,
          });
        });

        afterEach(async () => {
          await runtime.dispose();
          await storageManager.close();
        });

        /**
         * Stores a profile in a document of its own and a holder of
         * `placement` under `cause`, reads the handle the holder holds through
         * `position`, and reports where the handle points and the reads the
         * transaction records for conflicts. The profile's document is named
         * `profile`, the holder's `holder`.
         */
        async function observe(
          cause: string,
          placement: Placement,
          position: JSONSchema,
        ) {
          const write = runtime.edit();
          const profile = runtime.getCell(
            space,
            `${cause}-profile`,
            undefined,
            write,
          );
          profile.setRaw({ name: "Ada" });
          runtime.getCell(space, cause, undefined, write).setRaw(
            placement.value(profile.getAsLink()) as never,
          );
          await write.commit();
          const profileId = profile.getAsNormalizedFullLink().id;

          const tx = runtime.edit();
          tx.markLazyMaterialize(lazy);
          const holder = runtime.getCell(
            space,
            cause,
            placement.schema(position),
            tx,
          );
          const handle = placement.handle(holder.get());
          if (!isCell(handle)) throw new Error("the position read no handle");
          const name = (id: string) => id === profileId ? "profile" : "holder";
          const link = handle.getAsNormalizedFullLink();
          const replica = storageManager.open(space).replica as SpaceReplica;
          const conflict = replica.accessForTestingOnly.buildReads(tx.tx, 1)
            .confirmed.map((read) =>
              `${name(read.id)}/${read.path.join(".")}${
                read.nonRecursive ? " (shallow)" : ""
              }`
            );
          tx.abort();
          return {
            handle: `${name(link.id)}/${link.path.join(".")}`,
            conflict: [...new Set(conflict)].sort(),
          };
        }

        for (const placement of placements) {
          it(`records a single handle's reads for a union of handles at ${placement.name}`, async () => {
            const expected = await observe("single", placement, singleHandle);
            if (placement.linked) {
              expect(expected.handle).toBe("profile/");
              expect(expected.conflict).not.toContain("profile/value");
            }
            expect(await observe("union", placement, unionOfHandles))
              .toEqual(expected);
          });
        }
      });

      describe("another session changing the profile a linked property holds", () => {
        // Manual fan-out keeps the change from reaching the reader, so the
        // reader's commit arrives on the basis it read and the server decides
        // the conflict from the reads the commit carries.

        let server: MemoryV2Server.Server;
        let writerStorage: EmulatedStorageManager;
        let readerStorage: EmulatedStorageManager;
        let writer: Runtime;
        let reader: Runtime;

        beforeEach(() => {
          server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
          writerStorage = EmulatedStorageManager.connectTo(server, {
            as: signer,
          });
          readerStorage = EmulatedStorageManager.connectTo(server, {
            as: signer,
          });
          writer = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: writerStorage,
          });
          reader = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: readerStorage,
          });
        });

        afterEach(async () => {
          await reader.dispose();
          await writer.dispose();
          await readerStorage.close();
          await writerStorage.close();
          await server.close();
        });

        /**
         * Reads the handle `{ profile }` holds through `position` in a
         * transaction that also writes, has the writer set `key` on the
         * profile meanwhile, and returns the reader's commit.
         */
        async function commitAfterChange(
          position: JSONSchema,
          key: "name" | "title",
          readThrough = false,
        ) {
          const seed = writer.edit();
          const profile = writer.getCell(space, "profile", undefined, seed);
          profile.setRaw({ name: "Ada" });
          writer.getCell(space, "holder", undefined, seed).setRaw(
            { profile: profile.getAsLink() } as never,
          );
          await seed.commit({ resolveAt: "verdict" });
          await writerStorage.synced();
          for (const cause of ["holder", "profile"]) {
            await reader.getCell(space, cause).sync();
          }

          const tx = reader.edit();
          tx.markLazyMaterialize(lazy);
          const handle = (reader.getCell(
            space,
            "holder",
            holderOf(position),
            tx,
          ).get() as { profile: unknown }).profile;
          if (!isCell(handle)) throw new Error("the property read no handle");
          if (readThrough) {
            expect((handle as Cell<{ name: string }>).get().name).toBe("Ada");
          }
          reader.getCell(space, "output", undefined, tx).setRaw("written");

          const change = writer.edit();
          (profile.withTx(change) as Cell<Record<string, string>>).key(key)
            .set("Grace");
          expect((await change.commit({ resolveAt: "verdict" })).error)
            .toBeUndefined();
          await writerStorage.synced();

          return await tx.commit({ resolveAt: "verdict" });
        }

        for (
          const [kind, position] of [
            ["a single handle", singleHandle],
            ["a union of handles", unionOfHandles],
          ] as const
        ) {
          it(`commits a reader holding ${kind} when the name changes`, async () => {
            expect((await commitAfterChange(position, "name")).error)
              .toBeUndefined();
          });

          it(`rejects a reader that read the name through ${kind}`, async () => {
            expect((await commitAfterChange(position, "name", true)).error)
              .toBeDefined();
          });
        }

        it("rejects a reader holding a handle or a value when the profile gains the field that decides between them", async () => {
          // Only a union whose every branch is a handle resolves a reference
          // alone; here the reads deciding the branch decide what the reader
          // holds.

          expect((await commitAfterChange(handleOrValue, "title")).error)
            .toBeDefined();
        });
      });
    });
  }
});

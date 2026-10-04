import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertRejects } from "@std/assert";
import { siteTableCause, siteTableSchema } from "@commonfabric/home-schemas";
import {
  createSession,
  Identity,
  legacySpaceDid,
} from "@commonfabric/identity";
import {
  ACLManager,
  resolveEntryIdentity,
  Runtime,
  SpaceNotFoundError,
} from "@commonfabric/runner";
import type { MemorySpace } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("pieces controller spaces");
const apiUrl = new URL("http://toolshed.test");

/** A space a Home list names by DID, which the adoption cases seed. */
const current = (await Identity.fromPassphrase("current space")).did();

type SpaceEntry = { name: string; did?: string };

// A Home pattern reduced to its space list and the two streams the controller
// sends to it. The handlers are the ones `packages/patterns/system/home.tsx`
// defines, so the list a case reads back is the one a real Home would hold.
const HOME_SOURCE = `
import { handler, pattern, Writable } from "commonfabric";

type SpaceEntry = { name: string; did?: string };

const addSpace = handler<
  { did?: string; name?: string },
  { spaces: Writable<SpaceEntry[]> }
>(({ did, name }, { spaces }) => {
  if (!did) return;
  const entry = spaces.elementById(did);
  entry.set({ name: name ?? "", did });
  spaces.addUnique(entry);
});

const adoptSpace = handler<
  { name: string; did: string },
  { spaces: Writable<SpaceEntry[]> }
>(({ name, did }, { spaces }) => {
  if (!name || !did) return;
  const entry = spaces.elementById(did);
  entry.set({ name, did });
  spaces.addUnique(entry);
  spaces.removeByValue(spaces.elementById(name));
});

export default pattern<void>(() => {
  const spaces = new Writable<SpaceEntry[]>([]).for("spaces");
  return {
    spaces,
    addSpace: addSpace({ spaces }),
    adoptSpace: adoptSpace({ spaces }),
  };
});
`;

const DEFAULT_APP_SOURCE = `
import { pattern } from "commonfabric";
export default pattern<{ items: string[] }>(({ items }) => ({ items }));
`;

/**
 * Serves the two system patterns from memory, and nothing else, answering an
 * `identity` query with the identity the source compiles to, as a toolshed
 * does.
 */
function installFetchStub(): () => void {
  const sources: Record<string, string> = {
    "/api/patterns/system/home.tsx": HOME_SOURCE,
    "/api/patterns/system/default-app.tsx": DEFAULT_APP_SOURCE,
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const source = sources[url.pathname];
    if (source === undefined) {
      return new Response("not found", { status: 404 });
    }
    if (url.searchParams.has("identity")) {
      return new Response(
        await resolveEntryIdentity(url.pathname, () => Promise.resolve(source)),
        { headers: { "content-type": "text/plain" } },
      );
    }
    return new Response(source, {
      headers: { "content-type": "text/typescript-jsx" },
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("pieces-controller", () => {
  describe("PiecesController", () => {
    let restoreFetch: () => void;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      restoreFetch = installFetchStub();
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({ apiUrl, storageManager });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
      restoreFetch();
    });

    async function open(
      space: MemorySpace,
      spaceName?: string,
    ): Promise<PiecesController> {
      const pieces = new PiecesController(
        createSession({ identity: signer, spaceDid: space }),
        runtime,
        spaceName === undefined ? {} : { spaceName },
      );
      await pieces.synced();
      return pieces;
    }

    async function homeSpaces(home: PiecesController): Promise<SpaceEntry[]> {
      const root = (await home.ensureDefaultPattern()).getCell();
      await runtime.idle();
      return root.key("spaces").get() as SpaceEntry[];
    }

    async function siteTable(): Promise<
      { did: string; host: string; source?: string }[]
    > {
      const table = runtime.getCell(
        signer.did(),
        siteTableCause(signer.did()),
        siteTableSchema,
      );
      await table.sync();
      return (table.get() ?? []).map(({ did, host, source }) => ({
        did,
        host,
        source,
      }));
    }

    describe("instance members", () => {
      describe("ensureDefaultPattern()", () => {
        it("throws `SpaceNotFoundError` for a DID with no history, and writes nothing to it", async () => {
          const space = (await Identity.generate()).did();
          const pieces = await open(space);

          const error = await assertRejects(
            () => pieces.ensureDefaultPattern(),
            SpaceNotFoundError,
          );

          expect(error.space).toBe(space);
          expect(error.message).toBe(`No space answers to ${space}`);
          expect(await new ACLManager(runtime, space).get()).toBeNull();
          const spaceCell = runtime.getSpaceCell(space);
          await spaceCell.sync();
          expect(spaceCell.getRaw()).toBeUndefined();
          expect(await runtime.spaceExists(space)).toBe(false);
        });

        it("names the legacy name the controller was opened by in the `SpaceNotFoundError`", async () => {
          const space = await legacySpaceDid("team-lunch");
          const pieces = await open(space, "team-lunch");

          const error = await assertRejects(
            () => pieces.ensureDefaultPattern(),
            SpaceNotFoundError,
          );

          expect(error.space).toBe(space);
          expect(error.message).toBe(
            `No space answers to the name "team-lunch" (${space})`,
          );
          expect(await runtime.spaceExists(space)).toBe(false);
        });

        it("creates the root of a space whose genesis committed without one", async () => {
          const space = await runtime.createSpace();
          const pieces = await open(space);
          expect(await pieces.getDefaultPattern(false)).toBeUndefined();

          const root = (await pieces.ensureDefaultPattern()).getCell();

          expect(
            (await pieces.getDefaultPattern(false))?.equalLinks(root),
          ).toBe(true);
          expect(root.space).toBe(space);
        });

        it("creates the Home space and its root on the identity's first open", async () => {
          const home = await open(signer.did());
          expect(await home.getDefaultPattern(false)).toBeUndefined();

          const root = (await home.ensureDefaultPattern()).getCell();

          expect(
            (await home.getDefaultPattern(false))?.equalLinks(root),
          ).toBe(true);
          expect(await runtime.spaceExists(signer.did())).toBe(true);
        });
      });

      describe("recreateDefaultPattern()", () => {
        it("throws `SpaceNotFoundError` for a DID with no history, and writes nothing to it", async () => {
          const space = (await Identity.generate()).did();
          const pieces = await open(space);

          const error = await assertRejects(
            () => pieces.recreateDefaultPattern(),
            SpaceNotFoundError,
          );

          expect(error.space).toBe(space);
          const spaceCell = runtime.getSpaceCell(space);
          await spaceCell.sync();
          expect(spaceCell.getRaw()).toBeUndefined();
          expect(await runtime.spaceExists(space)).toBe(false);
        });
      });

      describe("createSpace()", () => {
        it("returns the DID of a space whose only owner is the identity", async () => {
          const home = await open(signer.did());

          const space = await home.createSpace("Garden");

          expect(space).not.toBe(signer.did());
          expect(await runtime.spaceExists(space)).toBe(true);
          expect(await new ACLManager(runtime, space).get()).toEqual({
            [signer.did()]: "OWNER",
          });
        });

        it("records the space in the Home space list under its label as its name", async () => {
          const home = await open(signer.did());

          const space = await home.createSpace("Garden");

          expect(await homeSpaces(home)).toEqual([
            { name: "Garden", did: space },
          ]);
        });

        it("records the space in the site table as served by the runtime's host", async () => {
          const home = await open(signer.did());

          const space = await home.createSpace("Garden");

          expect(await siteTable()).toEqual([
            { did: space, host: apiUrl.origin, source: "created" },
          ]);
        });

        it("returns two different DIDs for two calls with one label", async () => {
          const home = await open(signer.did());

          const first = await home.createSpace("Garden");
          const second = await home.createSpace("Garden");

          expect(second).not.toBe(first);
          expect(await homeSpaces(home)).toEqual([
            { name: "Garden", did: first },
            { name: "Garden", did: second },
          ]);
        });

        it("throws on a controller over a space other than the identity's Home", async () => {
          const pieces = await open(await runtime.createSpace());

          await expect(pieces.createSpace("Garden")).rejects.toThrow(
            "Only a controller over the identity's Home space can create a space",
          );
          expect(await siteTable()).toEqual([]);
        });
      });

      describe("adoptLegacySpaces()", () => {
        // The rows are seeded the way each is written: a legacy row keyed by
        // its name, as a typed name is added, and a row keyed by its DID, as a
        // created space is added.

        async function seedSpaces(home: PiecesController): Promise<void> {
          const root = (await home.ensureDefaultPattern()).getCell();
          const rows: [string, SpaceEntry][] = [
            ["Work", { name: "Work" }],
            [current, { name: "Current", did: current }],
          ];
          await runtime.editWithRetry((tx) => {
            const spaces = root.withTx(tx).key("spaces");
            for (const [key, row] of rows) {
              const entry = spaces.elementById(key);
              entry.set(row);
              spaces.addUnique(entry);
            }
          });
          await runtime.idle();
        }

        it("replaces each legacy row with one keyed by the DID its name resolves to and called by the name", async () => {
          const home = await open(signer.did());
          await seedSpaces(home);

          await home.adoptLegacySpaces();

          const spaces = await homeSpaces(home);
          expect(spaces).toHaveLength(2);
          expect(spaces).toContainEqual({
            name: "Work",
            did: await legacySpaceDid("Work"),
          });
          expect(spaces).toContainEqual({ name: "Current", did: current });
          expect(spaces.some((row) => row.did === undefined)).toBe(false);
        });

        it("records each adopted space in the site table, and no other", async () => {
          const home = await open(signer.did());
          await seedSpaces(home);

          await home.adoptLegacySpaces();

          expect(await siteTable()).toEqual([
            {
              did: await legacySpaceDid("Work"),
              host: apiUrl.origin,
              source: "adopted",
            },
          ]);
        });

        it("creates no space for an adopted name", async () => {
          const home = await open(signer.did());
          await seedSpaces(home);

          await home.adoptLegacySpaces();

          expect(await runtime.spaceExists(await legacySpaceDid("Work")))
            .toBe(false);
        });

        it("throws on a controller over a space other than the identity's Home", async () => {
          const pieces = await open(await runtime.createSpace());

          await expect(pieces.adoptLegacySpaces()).rejects.toThrow(
            "Only a controller over the identity's Home space can adopt legacy spaces",
          );
        });
      });
    });
  });
});

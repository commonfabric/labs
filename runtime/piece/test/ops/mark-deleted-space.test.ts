import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  markDeletedSpaceOf,
  retireDeletedProfileOf,
} from "../../src/ops/mark-deleted-space.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { installCustomRoot } from "../install-custom-root.ts";

const identity = await Identity.fromPassphrase("mark deleted space owner");
const HOST = "https://home.example";
const GONE = "did:key:mark-deleted-gone" as MemorySpace;
const KEPT = "did:key:mark-deleted-kept" as MemorySpace;
const ARCHIVED = "did:key:mark-deleted-archived" as MemorySpace;
const UNLISTED = "did:key:mark-deleted-unlisted" as MemorySpace;
const PROFILE = "did:key:mark-deleted-profile" as MemorySpace;
const RETIRED = "did:key:mark-deleted-retired-profile" as MemorySpace;

/**
 * A Home pattern reduced to its catalog, its profile lists, and the streams a
 * mark and a retirement are sent to. Each records what it was sent: the mark
 * as sent, and a retirement by the space of the profile it names.
 */
const catalogSource = `
import { type Cell, handler, pattern, spaceOf, Writable } from "commonfabric";
type Profile = { name?: string };
type Catalog = {
  entries: Record<string, { state: string; revision: string }>;
  offers: Record<string, unknown>;
};
type Mark = { space: string; expectedRevision: string };
const markSharedSpaceDeleted = handler<Mark, { marked: Writable<Mark[]> }>(
  (mark, { marked }) => {
    marked.push(mark);
  },
);
const retireProfile = handler<
  { profile?: Cell<Profile> },
  { retirements: Writable<string[]> }
>((event, { retirements }) => {
  retirements.push(spaceOf(event.profile) ?? "");
});
export default pattern(() => {
  const sharedSpaceCatalog = new Writable<Catalog>({
    entries: {
      "${GONE}": { state: "saved", revision: "2:gone" },
      "${KEPT}": { state: "deleted", revision: "3:kept" },
      "${ARCHIVED}": { state: "archived", revision: "1:archived" },
    },
    offers: {},
  }).for("sharedSpaceCatalog");
  const marked = new Writable<Mark[]>([]).for("marked");
  const profiles = new Writable<Profile[]>([]).for("profiles");
  const retiredProfiles = new Writable<Profile[]>([]).for("retiredProfiles");
  const retirements = new Writable<string[]>([]).for("retirements");
  return {
    sharedSpaceCatalog,
    marked,
    profiles,
    retiredProfiles,
    retirements,
    markSharedSpaceDeleted: markSharedSpaceDeleted({ marked }),
    retireProfile: retireProfile({ retirements }),
  };
});`;

const program: RuntimeProgram = {
  main: "/home.tsx",
  files: [{ name: "/home.tsx", contents: catalogSource }],
};

/** The same Home from before the command, which exports no such stream. */
const olderProgram: RuntimeProgram = {
  main: "/older-home.tsx",
  files: [{
    name: "/older-home.tsx",
    contents: catalogSource.replace(
      "    markSharedSpaceDeleted: markSharedSpaceDeleted({ marked }),\n",
      "",
    ).replace("    retireProfile: retireProfile({ retirements }),\n", ""),
  }],
};

/**
 * The same Home with its commands, and no catalog or profile list to read, as a
 * read finds nothing while a Home is still producing them.
 */
const unreadableProgram: RuntimeProgram = {
  main: "/unreadable-home.tsx",
  files: [{
    name: "/unreadable-home.tsx",
    contents: catalogSource.replace("    sharedSpaceCatalog,\n", "").replace(
      "    profiles,\n",
      "",
    ),
  }],
};

const markedSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      space: { type: "string" },
      expectedRevision: { type: "string" },
    },
    required: ["space", "expectedRevision"],
  },
} as const;

describe("mark-deleted-space", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL(HOST),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    controller = new PiecesController(
      createSession({ identity, spaceDid: identity.did() }),
      runtime,
    );
    await controller.synced();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  /** The marks `home`'s stand-in recorded, once the runtime has handled them. */
  const marked = async (home: Cell<unknown>) => {
    await runtime.idle();
    return await home.key("marked").asSchema(markedSchema).pull();
  };

  /**
   * The spaces of the profiles `home`'s stand-in was sent retirements for,
   * once the runtime has handled them.
   */
  const retirements = async (home: Cell<unknown>) => {
    await runtime.idle();
    return await home.key("retirements").asSchema(
      { type: "array", items: { type: "string" } } as const,
    ).pull();
  };

  /**
   * Fills `home`'s profile lists with links to a profile document in each of
   * `profiles`, and in each of `retired`, as Home's lists link profiles.
   */
  const listProfiles = async (
    home: Cell<unknown>,
    profiles: MemorySpace[],
    retired: MemorySpace[],
  ) => {
    const linksTo = (spaces: MemorySpace[]) =>
      spaces.map((space) => runtime.getCell(space, `profile-${space}`));
    const { error } = await runtime.editWithRetry((tx) => {
      home.key("profiles").withTx(tx).set(linksTo(profiles));
      home.key("retiredProfiles").withTx(tx).set(linksTo(retired));
    });
    expect(error).toBeUndefined();
    await runtime.idle();
  };

  describe("markDeletedSpaceOf()", () => {
    it("sends a mark for a saved or archived entry, at the revision the catalog holds", async () => {
      const home = await installCustomRoot(runtime, controller, program);
      expect(await markDeletedSpaceOf(home, GONE)).toBe("sent");
      expect(await markDeletedSpaceOf(home, ARCHIVED)).toBe("sent");
      expect(await marked(home)).toEqual([
        { space: GONE, expectedRevision: "2:gone" },
        { space: ARCHIVED, expectedRevision: "1:archived" },
      ]);
    });

    it("sends nothing for an entry already deleted, or a space the catalog does not list", async () => {
      const home = await installCustomRoot(runtime, controller, program);
      expect(await markDeletedSpaceOf(home, KEPT)).toBe("not-saved");
      expect(await markDeletedSpaceOf(home, UNLISTED)).toBe("not-listed");
      expect(await marked(home)).toEqual([]);
    });

    it("sends nothing, and says so, when the read of the catalog gives nothing", async () => {
      const home = await installCustomRoot(
        runtime,
        controller,
        unreadableProgram,
      );
      expect(await markDeletedSpaceOf(home, GONE)).toBe("unread");
      expect(await marked(home)).toEqual([]);
    });

    it("sends nothing to a Home older than the command", async () => {
      const home = await installCustomRoot(runtime, controller, olderProgram);
      expect(await markDeletedSpaceOf(home, GONE)).toBe("no-command");
      expect(await marked(home)).toEqual([]);
    });
  });

  describe("retireDeletedProfileOf()", () => {
    it("sends a retirement for the profile Home lists in the space", async () => {
      const home = await installCustomRoot(runtime, controller, program);
      await listProfiles(home, [PROFILE, RETIRED], [RETIRED]);
      expect(await retireDeletedProfileOf(home, PROFILE)).toBe("sent");
      expect(await retirements(home)).toEqual([PROFILE]);
    });

    it("sends nothing for a profile retired already, or a space Home lists no profile in", async () => {
      const home = await installCustomRoot(runtime, controller, program);
      await listProfiles(home, [PROFILE, RETIRED], [RETIRED]);
      expect(await retireDeletedProfileOf(home, RETIRED)).toBe("retired");
      expect(await retireDeletedProfileOf(home, UNLISTED)).toBe("not-listed");
      expect(await retirements(home)).toEqual([]);
    });

    it("sends nothing to a Home older than the command", async () => {
      const home = await installCustomRoot(runtime, controller, olderProgram);
      expect(await retireDeletedProfileOf(home, PROFILE)).toBe("no-command");
    });

    it("sends nothing, and says so, when the read of the profiles gives nothing", async () => {
      const home = await installCustomRoot(
        runtime,
        controller,
        unreadableProgram,
      );
      expect(await retireDeletedProfileOf(home, PROFILE)).toBe("unread");
      expect(await retirements(home)).toEqual([]);
    });
  });

  describe("PiecesController.markDeletedSpace()", () => {
    it("answers `no-home` where the identity has no Home, creating none", async () => {
      expect(await controller.markDeletedSpace(GONE)).toBe("no-home");
      expect(await controller.getDefaultPattern(false)).toBeUndefined();
    });

    it("marks through the Home the identity has", async () => {
      const home = await installCustomRoot(runtime, controller, program);
      expect(await controller.markDeletedSpace(GONE)).toBe("sent");
      expect(await marked(home)).toEqual([
        { space: GONE, expectedRevision: "2:gone" },
      ]);
    });

    it("retires the profile Home lists in a deleted space, as well as marking the catalog", async () => {
      const home = await installCustomRoot(runtime, controller, program);
      await listProfiles(home, [PROFILE], []);
      expect(await controller.markDeletedSpace(PROFILE)).toBe("not-listed");
      expect(await retirements(home)).toEqual([PROFILE]);
      expect(await marked(home)).toEqual([]);
    });
  });
});

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
import { markDeletedSpaceOf } from "../../src/ops/mark-deleted-space.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { installCustomRoot } from "../install-custom-root.ts";

const identity = await Identity.fromPassphrase("mark deleted space owner");
const HOST = "https://home.example";
const GONE = "did:key:mark-deleted-gone" as MemorySpace;
const KEPT = "did:key:mark-deleted-kept" as MemorySpace;
const ARCHIVED = "did:key:mark-deleted-archived" as MemorySpace;
const UNLISTED = "did:key:mark-deleted-unlisted" as MemorySpace;

/** A Home pattern reduced to its catalog and the stream a mark is sent to. */
const catalogSource = `
import { handler, pattern, Writable } from "commonfabric";
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
  return {
    sharedSpaceCatalog,
    marked,
    markSharedSpaceDeleted: markSharedSpaceDeleted({ marked }),
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

    it("sends nothing to a Home older than the command", async () => {
      const home = await installCustomRoot(runtime, controller, olderProgram);
      expect(await markDeletedSpaceOf(home, GONE)).toBe("no-command");
      expect(await marked(home)).toEqual([]);
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
  });
});

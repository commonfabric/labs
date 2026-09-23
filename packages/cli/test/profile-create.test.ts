/**
 * Drives `createProfile()` against a runtime with no renderer, hosting the
 * real `profile-create.tsx` behind a stubbed connection, so that what is
 * checked is the whole of what the command does once connected: the event it
 * builds reaches the create handler, the profile is born in a space of its
 * own, and the address returned names it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "@commonfabric/piece/ops";

import type { SpaceConfig } from "../lib/piece.ts";
import {
  createdByThisCall,
  createProfile,
  type ProfileCreateConfig,
} from "../lib/profile.ts";

const sysDir = fromFileUrl(
  new URL("../../patterns/system/", import.meta.url),
);
const read = (name: string) => Deno.readTextFileSync(sysDir + name);

// A host owning a `profiles` list, embedding the real create pattern and
// exposing its stream under the name the home pattern exposes its own.
const WRAPPER_SRC = [
  "import ProfileCreate from './profile-create.tsx';",
  "import { pattern, Writable } from 'commonfabric';",
  "import type { ProfileHomeOutput } from './profile-home.tsx';",
  "",
  "export default pattern(() => {",
  "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
  "  const created = ProfileCreate({ profiles });",
  "  return { profiles, createProfile: created.createProfile };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: WRAPPER_SRC },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

const signer = await Identity.fromPassphrase("cf-profile-create");
const space = signer.did();

const CONFIG: ProfileCreateConfig = {
  apiUrl: "http://127.0.0.1:8000",
  identity: "/unread.key",
  space,
  name: "Ada Lovelace",
};

describe("createProfile()", () => {
  // One server behind every manager, so a second runtime connected to it
  // reads what the first committed the way a later process reads it.
  let server: ReturnType<typeof newLoopbackServer>;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  // deno-lint-ignore no-explicit-any
  let host: any;
  // deno-lint-ignore no-explicit-any
  let loadPieces: any;

  beforeEach(async () => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    const tx = runtime.edit();
    const parent = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "cf profile create host",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    host = runtime.run(tx, parent as any, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    const setup = await tx.commit();
    expect(setup.error).toBeUndefined();
    await host.pull();
    // The connections the command would open: to the home space, answering
    // with this host as the home root; and to the created profile's space,
    // a runtime of its own over the same server, as a second connection
    // from one process is.
    loadPieces = (config: SpaceConfig) => {
      if (config.space === space) {
        return Promise.resolve({
          runtime,
          synced: () => Promise.resolve(),
          ensureDefaultPattern: () => Promise.resolve({ getCell: () => host }),
        });
      }
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const profileRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const pieces = new PiecesController(
        { as: signer, space: config.space as MemorySpace },
        profileRuntime,
        { deferSpaceCellSync: true },
      );
      pieces.dispose = async () => {
        await profileRuntime.dispose({ closeStorage: false });
        await storage.close();
      };
      return Promise.resolve(pieces);
    };
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await manager.close();
    await server.close();
  });

  it("creates the profile in a space of its own and returns its address", async () => {
    const created = await createProfile(CONFIG, { loadPieces });
    expect(created.name).toBe("Ada Lovelace");
    expect(created.space).not.toBe(space);
    expect(created.address).toContain(created.space);
    expect(created.address).toContain(created.id);
  });

  it("stores the profile's `name`, which a fresh runtime reads back", async () => {
    // The name is a computed output of the profile piece, and a reader with
    // no shell — `cf profile show`, a `#profile` wish — runs nothing to
    // produce it; the create has to have run the piece once.
    const created = await createProfile(CONFIG, { loadPieces });
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const name = reader.getCellFromEntityId<string>(
        created.space as MemorySpace,
        created.id,
        ["name"],
      );
      await name.pull();
      expect(name.get()).toBe("Ada Lovelace");
    } finally {
      await reader.dispose({ closeStorage: false });
      await readerStorage.close();
    }
  });

  it("returns the profile the call made, not one already there", async () => {
    const first = await createProfile(CONFIG, { loadPieces });
    const second = await createProfile(
      { ...CONFIG, name: "Alan Turing" },
      { loadPieces },
    );
    expect(second.name).toBe("Alan Turing");
    expect(second.space).not.toBe(first.space);
  });

  it("refuses a name carrying a control character", async () => {
    await expect(createProfile({ ...CONFIG, name: "Ada\u001bLovelace" }, {
      loadPieces,
    })).rejects.toThrow(/control characters/);
  });

  it("picks the profile carrying this call's name when two appeared at once, and refuses a tie", async () => {
    // Two profiles land between one call's first read and its second, as
    // two processes creating at once make happen.
    const ada = await createProfile(CONFIG, { loadPieces });
    const alan = await createProfile({ ...CONFIG, name: "Alan Turing" }, {
      loadPieces,
    });
    const links = host.key("profiles").asSchema({
      type: "array",
      items: { type: "unknown", asCell: ["cell"] },
      // deno-lint-ignore no-explicit-any
    } as any).get() as Cell<unknown>[];
    const candidates: [string, Cell<unknown>][] = links.map((link) => [
      link.getAsNormalizedFullLink().space,
      link,
    ]);
    expect(candidates.map(([space]) => space).sort())
      .toEqual([ada.space, alan.space].sort());
    const picked = await createdByThisCall(candidates, "Alan Turing");
    expect(picked?.[0]).toBe(alan.space);
    expect(picked?.[1].getAsNormalizedFullLink().id).toBe(alan.id);
    expect(picked?.[1].getAsNormalizedFullLink().path).toEqual([]);
    const redirectRuntime = picked![1].runtime;
    const redirectTx = redirectRuntime.edit();
    const slot = redirectRuntime.getCell<unknown>(
      signer.did(),
      "profile-redirect",
      undefined,
      redirectTx,
    );
    slot.set(picked![1]);
    expect((await redirectTx.commit()).error).toBeUndefined();
    for (
      const redirectedCandidates of [
        [[signer.did(), slot.withTx()]] as [string, Cell<unknown>][],
        [[signer.did(), slot.withTx()], candidates[0]] as [
          string,
          Cell<unknown>,
        ][],
      ]
    ) {
      const resolved = await createdByThisCall(
        redirectedCandidates,
        "Alan Turing",
      );
      expect(resolved?.[0]).toBe(alan.space);
      expect(resolved?.[1].getAsNormalizedFullLink().id).toBe(alan.id);
    }
    const twoAdas = await createProfile(CONFIG, { loadPieces });
    const tie = candidates.filter(([space]) => space !== alan.space).concat([[
      twoAdas.space,
      links.length === 3 ? links[2] : candidates[0][1],
    ]]);
    await expect(createdByThisCall(tie, "Ada Lovelace")).rejects.toThrow(
      /more than one carries that name/,
    );
    expect(await createdByThisCall([], "Ada Lovelace")).toBeUndefined();
  });

  it("trims the name and refuses a blank one before connecting", async () => {
    let connected = 0;
    const counting = (config: SpaceConfig) => {
      connected++;
      return loadPieces(config);
    };
    await expect(createProfile({ ...CONFIG, name: "  " }, {
      loadPieces: counting,
    })).rejects.toThrow(/needs a name/);
    expect(connected).toBe(0);
    const created = await createProfile({ ...CONFIG, name: "  Ada  " }, {
      loadPieces: counting,
    });
    expect(created.name).toBe("Ada");
  });
});

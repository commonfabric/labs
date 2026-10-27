/**
 * Drives `listProfiles()`, `renameProfile()`, `setProfilePicture()`,
 * `retireProfile()` and `restoreProfile()` against a runtime with no
 * renderer, running the real Home pattern behind a stubbed connection, so
 * that each command meets the write contracts Home's lists carry. The
 * profiles are made by `createProfile()`, as profile-create.test.ts drives it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { isWellFormedDID } from "@commonfabric/identity/did";
import {
  type Cell,
  getDerivedInternalCellLink,
  isLink,
  type JSONSchema,
  type MemorySpace,
  type NormalizedFullLink,
  parseLink,
  Runtime,
  systemPatternSource,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { createCompileByteCache } from "@commonfabric/test-support/compile-byte-cache";

import { PiecesController } from "@commonfabric/piece/ops";

import {
  asStoredValue,
  seedStoredEnvelope,
  storedFields,
  storedList,
} from "../../runner/test/cfc-seed-envelope.ts";
import type { loadPieces as loadPiecesOf, SpaceConfig } from "../lib/piece.ts";
import {
  attestProfileName,
  createProfile,
  listProfiles,
  PROFILE_PICTURE_MAX_BYTES,
  renameProfile,
  restoreProfile,
  retireProfile,
  setProfilePicture,
} from "../lib/profile.ts";

const signer = await Identity.fromPassphrase("cf-profile-manage");
const stranger = await Identity.fromPassphrase("cf-profile-manage stranger");

// A PNG's signature and header chunk start, which is what a picture is checked
// by; a profile stores the bytes as they are.
const picture = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  13,
]);
const space = signer.did();

/** A list of profile links, each read as the link it is. */
const linkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const satisfies JSONSchema;

/** The space a created profile lives in. */
function spaceOf(profile: { space: string }): MemorySpace {
  if (!isWellFormedDID(profile.space)) {
    throw new Error(`${profile.space} names no space.`);
  }
  return profile.space;
}

const CONFIG: SpaceConfig = {
  apiUrl: "http://127.0.0.1:8000",
  identity: "/unread.key",
  space,
};

// One cache for every runtime this file makes, so that a pattern compiles
// once per file rather than once per case.
const moduleByteCache = createCompileByteCache();

describe("profile management", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let host: Cell<Record<string, unknown>>;
  let loadPieces: typeof loadPiecesOf;
  // Who a connection to a profile's own space acts as.
  let profileSigner: Identity;

  beforeEach(async () => {
    profileSigner = signer;
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      moduleByteCache,
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: new URL("../../patterns/system/home.tsx", import.meta.url)
          .pathname,
        root: new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
    );
    const tx = runtime.edit();
    const home = await runtime.patternManager.compilePattern(
      program,
      {
        space,
        tx,
      },
    );
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "cf profile manage home",
      undefined,
      tx,
    );
    host = runtime.run(tx, home, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await host.pull();
    // The home connection answers with this host as the home root, and is
    // the test's to close; any other space gets a runtime of its own over
    // the same server, as a second connection from one process is.
    const homePieces = new PiecesController(
      { as: signer, space },
      runtime,
      { deferSpaceCellSync: true },
    );
    await homePieces.linkDefaultPattern(host);
    // The runtime is the test's to dispose.
    homePieces.dispose = () => Promise.resolve();
    loadPieces = (config: SpaceConfig) => {
      if (config.space === space) return Promise.resolve(homePieces);
      if (!isWellFormedDID(config.space)) {
        throw new Error(`${config.space} names no space.`);
      }
      const storage = EmulatedStorageManager.connectTo(server, {
        as: profileSigner,
      });
      const profileRuntime = new Runtime({
        moduleByteCache,
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const pieces = new PiecesController(
        { as: profileSigner, space: config.space },
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

  /**
   * Links the profile at `link` from the owner's Home list `key`, `profiles`
   * by default, writing the stored document beneath the runtime's write
   * checks, since the list's write policies refuse every writer but Home's
   * handlers.
   */
  async function listInHome(
    link: NormalizedFullLink,
    key: "profiles" | "retiredProfiles" = "profiles",
  ): Promise<void> {
    const list = host.key(key).resolveAsCell();
    await list.sync();
    const document = { ...list.getAsNormalizedFullLink(), path: [] };
    const tx = runtime.edit();
    const stored = storedFields(tx, document);
    seedStoredEnvelope(tx, document, {
      ...stored,
      value: [
        ...storedList(stored.value),
        asStoredValue(runtime.getCellFromLink(link).getAsLink()),
      ],
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await host.pull();
  }

  /** The names of the listed profiles, in the order they are listed. */
  async function listedNames(): Promise<string[]> {
    return (await listProfiles(CONFIG, { loadPieces })).map((each) =>
      each.name
    );
  }

  /**
   * Makes a profile as the stranger, in `profileSpace`, the stranger's own
   * space by default, names it `name` through its `setName`, and links it
   * from the owner's Home `profiles` list (`listInHome()`). Returns the
   * profile's space.
   */
  async function listStrangersProfile(
    name: string,
    profileSpace: MemorySpace = stranger.did(),
  ): Promise<string> {
    const storage = EmulatedStorageManager.connectTo(server, { as: stranger });
    const theirs = new Runtime({
      moduleByteCache,
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    let link: NormalizedFullLink;
    try {
      const program = await resolveLocalProgram(
        (resolver) => theirs.harness.resolve(resolver),
        {
          main: new URL(
            "../../patterns/system/profile-home.tsx",
            import.meta.url,
          ).pathname,
          root: new URL("../../..", import.meta.url).pathname.replace(
            /\/$/,
            "",
          ),
        },
      );
      let tx = theirs.edit();
      const pattern = await theirs.patternManager.compilePattern(program, {
        space: profileSpace,
        tx,
      });
      const cell = theirs.getCell<Record<string, unknown>>(
        profileSpace,
        "a stranger's profile",
        undefined,
        tx,
      );
      const profile = theirs.run(tx, pattern, { initialName: name }, cell);
      theirs.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await profile.pull();
      tx = theirs.edit();
      profile.withTx(tx).key("setName").send({ name });
      expect((await tx.commit().settled).error).toBeUndefined();
      await theirs.idle();
      await storage.synced();
      theirs.runner.stop(profile);
      link = profile.getAsNormalizedFullLink();
    } finally {
      await theirs.dispose({ closeStorage: false });
      await storage.close();
    }
    await listInHome(link);
    return link.space;
  }

  /** The link the owner's Home `profiles` list holds into `profileSpace`. */
  function listedLink(profileSpace: string): NormalizedFullLink {
    const link = (host.key("profiles").asSchema(linkListSchema).get() ?? [])
      .find((each) => each.getAsNormalizedFullLink().space === profileSpace);
    if (link === undefined) throw new Error(`Home lists no ${profileSpace}.`);
    return link.getAsNormalizedFullLink();
  }

  /**
   * Makes a profile named `name` as the owner, in a space of its own, from
   * the profile source the system serves, as Home makes one, and takes the
   * protection and label off its name cells, as a name stored before names
   * were labeled carries none, leaving the claim its name field's owner
   * policy installed when the profile was set up. Links it from the owner's
   * Home `profiles` list (`listInHome()`), and returns the profile's
   * address.
   */
  async function listProfileWithUnlabeledName(
    name: string,
  ): Promise<{ space: string; id: string }> {
    const profileSpace = await runtime.createSpace({
      grants: { "*": "WRITE" },
    });
    const route = "/api/patterns/system/profile-home.tsx";
    let tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      main: route,
      files: [{
        name: route,
        contents: Deno.readTextFileSync(
          new URL("../../patterns/system/profile-home.tsx", import.meta.url),
        ),
      }],
    }, { space: profileSpace, tx });
    const profile = runtime.getCell<Record<string, unknown>>(
      profileSpace,
      "a profile named before names were labeled",
      undefined,
      tx,
    );
    runtime.runner.run(tx, pattern, { initialName: name }, profile, {
      sourceOrigin: systemPatternSource("system/profile-home.tsx"),
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await profile.pull();
    tx = runtime.edit();
    profile.withTx(tx).key("setName").send({ name });
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    runtime.runner.stop(profile);
    const descriptor = pattern.derivedInternalCells?.find((item) =>
      item.partialCause === "name"
    );
    if (descriptor === undefined) throw new Error("No named name cell.");
    let target = getDerivedInternalCellLink(profile, descriptor);
    tx = runtime.edit();
    for (let depth = 0; depth < 2; depth++) {
      const document = { ...target, path: [] };
      const { cfc: _cfc, ...unlabeled } = storedFields(tx, document);
      seedStoredEnvelope(tx, document, unlabeled);
      const value = tx.readValueOrThrow(target);
      if (!isLink(value)) break;
      target = parseLink(value, target);
    }
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const link = profile.getAsNormalizedFullLink();
    await listInHome(link);
    return { space: link.space, id: link.id };
  }

  /**
   * Makes a document in a space of its own holding a name, `name`, and
   * carrying no label at all, and links it from the owner's Home `profiles`
   * list (`listInHome()`). Returns its space.
   */
  async function listUnlabeledDocument(name: string): Promise<string> {
    const documentSpace = await runtime.createSpace({
      grants: { "*": "WRITE" },
    });
    const document = runtime.getCell(documentSpace, "no one's profile");
    const tx = runtime.edit();
    document.withTx(tx).setRaw({ name });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await listInHome(document.getAsNormalizedFullLink());
    return documentSpace;
  }

  describe("listProfiles()", () => {
    it("returns no profiles for a person who has none", async () => {
      expect(await listProfiles(CONFIG, { loadPieces })).toEqual([]);
    });

    it("returns each profile's name, space and address, the first marked current", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
        loadPieces,
      });

      const listed = await listProfiles(CONFIG, { loadPieces });

      expect(listed.map((each) => [each.name, each.space, each.address]))
        .toEqual([
          ["Ada", ada.space, ada.address],
          ["Alan", alan.space, alan.address],
        ]);
      expect(listed.map((each) => each.current)).toEqual([true, false]);
      expect(listed.map((each) => each.picture)).toEqual([
        undefined,
        undefined,
      ]);
    });

    it("leaves out a listed profile that is another identity's", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const theirs = await listStrangersProfile("Mallory");
      const homeLinks = host.key("profiles").asSchema(linkListSchema).get() ??
        [];
      expect(homeLinks.map((each) => each.getAsNormalizedFullLink().space))
        .toContain(theirs);

      const listed = await listProfiles(CONFIG, { loadPieces });

      expect(listed.map((each) => [each.name, each.current])).toEqual([
        ["Ada", true],
      ]);
    });

    it("lists a profile whose name was stored before names were labeled, by the claim its name field's owner policy installed", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      await listProfileWithUnlabeledName("Alan");

      expect(await listedNames()).toEqual(["Ada", "Alan"]);
    });

    it("leaves out a listed document carrying no label at all", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      await listUnlabeledDocument("Mallory");

      expect(await listedNames()).toEqual(["Ada"]);
    });

    it("leaves out a profile whose name is another identity's, though the identity owns the profile's space", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const owned = await runtime.createSpace({ grants: { "*": "WRITE" } });
      await listStrangersProfile("Mallory", owned);

      expect(await listedNames()).toEqual(["Ada"]);
    });

    describe("with `includeRetired`", () => {
      it("lists an own retired profile after the live ones, marked retired, with its picture and what attests it", async () => {
        await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
        const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
          loadPieces,
        });
        await setProfilePicture(
          { ...CONFIG, profileSpace: alan.space, bytes: picture },
          { loadPieces },
        );
        await retireProfile({ ...CONFIG, profileSpace: alan.space }, {
          loadPieces,
        });

        const listed = await listProfiles(CONFIG, { loadPieces }, {
          includeRetired: true,
        });

        expect(listed.map((each) => [each.name, each.retired, each.current]))
          .toEqual([["Ada", undefined, true], ["Alan", true, false]]);
        expect(listed[1]).toMatchObject({
          space: alan.space,
          address: alan.address,
          picture,
          pictureByOwner: true,
          avatar: "",
          avatarByOwner: false,
        });
      });

      it("leaves the default listing as it was, with no retired profile and no row marked", async () => {
        await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
        const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
          loadPieces,
        });
        await retireProfile({ ...CONFIG, profileSpace: alan.space }, {
          loadPieces,
        });

        const listed = await listProfiles(CONFIG, { loadPieces });

        expect(listed.map((each) => each.name)).toEqual(["Ada"]);
        expect(Object.hasOwn(listed[0], "retired")).toBe(false);
      });

      it("leaves out a retired-list entry that is another identity's profile", async () => {
        await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
        const theirs = await listStrangersProfile("Mallory");
        await listInHome(listedLink(theirs), "retiredProfiles");

        const listed = await listProfiles(CONFIG, { loadPieces }, {
          includeRetired: true,
        });

        expect(listed.map((each) => each.name)).toEqual(["Ada"]);
      });

      it("throws, naming the space, when a retired profile cannot be read", async () => {
        await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
        const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
          loadPieces,
        });
        await retireProfile({ ...CONFIG, profileSpace: alan.space }, {
          loadPieces,
        });
        const sync = manager.syncCell.bind(manager);
        using _refused = stub(
          manager,
          "syncCell",
          (cell, options) =>
            cell.space === alan.space
              ? Promise.reject(new Error("access refused"))
              : sync(cell, options),
        );

        await expect(
          listProfiles(CONFIG, { loadPieces }, { includeRetired: true }),
        ).rejects.toThrow(`Cannot read the profile in ${alan.space}.`);
      });
    });

    it("throws, naming the space, when a profile after the current one cannot be read", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
        loadPieces,
      });
      const sync = manager.syncCell.bind(manager);
      using _refused = stub(
        manager,
        "syncCell",
        (cell, options) =>
          cell.space === alan.space
            ? Promise.reject(new Error("access refused"))
            : sync(cell, options),
      );

      await expect(listProfiles(CONFIG, { loadPieces })).rejects.toThrow(
        `Cannot read the profile in ${alan.space}.`,
      );
    });
  });

  describe("retireProfile()", () => {
    it("throws, creating no home, for a person who has none", async () => {
      const pieces = await loadPieces(CONFIG);
      using _homeless = stub(
        pieces,
        "getDefaultPattern",
        () => Promise.resolve(undefined),
      );
      using created = stub(
        pieces,
        "ensureDefaultPattern",
        () => Promise.reject(new Error("Home was created.")),
      );

      await expect(
        retireProfile({ ...CONFIG, profileSpace: space }, { loadPieces }),
      ).rejects.toThrow(/has no home/);
      expect(created.calls).toHaveLength(0);
    });

    it("leaves the retired profile out of the list, and the rest in it", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
        loadPieces,
      });

      await retireProfile({ ...CONFIG, profileSpace: alan.space }, {
        loadPieces,
      });

      expect(await listedNames()).toEqual(["Ada"]);
      expect((await listProfiles(CONFIG, { loadPieces }))[0].current).toBe(
        true,
      );
    });

    it("refuses a space no listed profile lives in", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });

      await expect(
        retireProfile({ ...CONFIG, profileSpace: space }, { loadPieces }),
      ).rejects.toThrow(/No profile/);
      expect(await listedNames()).toEqual(["Ada"]);
    });

    it("refuses a profile that is retired already", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
        loadPieces,
      });
      await retireProfile({ ...CONFIG, profileSpace: alan.space }, {
        loadPieces,
      });

      await expect(
        retireProfile({ ...CONFIG, profileSpace: alan.space }, { loadPieces }),
      ).rejects.toThrow(/is retired/);
    });

    it("refuses the profile `#profile` returns, and leaves it listed", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      await createProfile({ ...CONFIG, name: "Alan" }, { loadPieces });

      await expect(
        retireProfile({ ...CONFIG, profileSpace: ada.space }, { loadPieces }),
      ).rejects.toThrow(/^Retiring profile /);
      expect(await listedNames()).toEqual(["Ada", "Alan"]);
    });

    it("refuses a listed profile that is another identity's", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      await createProfile({ ...CONFIG, name: "Alan" }, { loadPieces });
      const theirs = await listStrangersProfile("Mallory");

      await expect(
        retireProfile({ ...CONFIG, profileSpace: theirs }, { loadPieces }),
      ).rejects.toThrow(/is not one of .* own/);
      expect(
        (host.key("retiredProfiles").asSchema(linkListSchema).get() ?? [])
          .length,
      ).toBe(0);
    });
  });

  describe("restoreProfile()", () => {
    it("lists the restored profile again", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
        loadPieces,
      });
      await retireProfile({ ...CONFIG, profileSpace: alan.space }, {
        loadPieces,
      });
      expect(await listedNames()).toEqual(["Ada"]);

      await restoreProfile({ ...CONFIG, profileSpace: alan.space }, {
        loadPieces,
      });

      expect(await listedNames()).toEqual(["Ada", "Alan"]);
    });

    it("refuses a profile that is not retired", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await expect(
        restoreProfile({ ...CONFIG, profileSpace: ada.space }, { loadPieces }),
      ).rejects.toThrow(/is not retired/);
      expect(await listedNames()).toEqual(["Ada"]);
    });
  });

  describe("attestProfileName()", () => {
    it("inspects a name carrying no label, naming it and changing nothing, and attests it given the inspection, after which it is attested already", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const older = await listProfileWithUnlabeledName("Alan");
      const target = { ...CONFIG, profileSpace: older.space };

      const inspected = await attestProfileName(target, { loadPieces });
      expect(inspected).toMatchObject({ status: "inspected", name: "Alan" });
      expect(await attestProfileName(target, { loadPieces })).toEqual(
        inspected,
      );
      if (inspected.status !== "inspected") throw new Error("Not inspected.");

      expect(
        await attestProfileName(
          { ...target, expectedInspection: inspected.inspection },
          { loadPieces },
        ),
      ).toEqual({ status: "attested", name: "Alan" });
      expect(await attestProfileName(target, { loadPieces })).toEqual({
        status: "already",
        name: "Alan",
      });
      expect(await listedNames()).toEqual(["Ada", "Alan"]);
    });

    it("refuses an inspection that does not match the profile, and changes nothing", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const older = await listProfileWithUnlabeledName("Alan");

      await expect(
        attestProfileName(
          { ...CONFIG, profileSpace: older.space, expectedInspection: "x" },
          { loadPieces },
        ),
      ).rejects.toThrow(/inspect it again/);
      expect(
        await attestProfileName({ ...CONFIG, profileSpace: older.space }, {
          loadPieces,
        }),
      ).toMatchObject({ status: "inspected", name: "Alan" });
    });

    it("attests the name of a retired profile, which a restore then lists", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const older = await listProfileWithUnlabeledName("Alan");
      const link = host.key("profiles").asSchema(linkListSchema).get()?.find(
        (each) => each.getAsNormalizedFullLink().space === older.space,
      );
      const tx = runtime.edit();
      host.withTx(tx).key("retireProfile").send({ profile: link });
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      const target = { ...CONFIG, profileSpace: older.space };

      const inspected = await attestProfileName(target, { loadPieces });
      if (inspected.status !== "inspected") throw new Error("Not inspected.");
      await attestProfileName(
        { ...target, expectedInspection: inspected.inspection },
        { loadPieces },
      );
      expect(await listedNames()).toEqual(["Ada"]);
      await restoreProfile(target, { loadPieces });

      expect(await listedNames()).toEqual(["Ada", "Alan"]);
    });

    it("returns `already`, changing nothing, for a name attested to the identity", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      expect(
        await attestProfileName({ ...CONFIG, profileSpace: ada.space }, {
          loadPieces,
        }),
      ).toEqual({ status: "already", name: "Ada" });
      expect(await listedNames()).toEqual(["Ada"]);
    });

    it("refuses a listed profile whose name is another identity's", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const theirs = await listStrangersProfile("Mallory");

      await expect(
        attestProfileName({ ...CONFIG, profileSpace: theirs }, { loadPieces }),
      ).rejects.toThrow(/is not one of .* own/);
      expect(await listedNames()).toEqual(["Ada"]);
    });

    it("refuses a space no listed profile lives in", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });

      await expect(
        attestProfileName({ ...CONFIG, profileSpace: stranger.did() }, {
          loadPieces,
        }),
      ).rejects.toThrow(/No profile of/);
    });

    it("refuses a listed document carrying no label at all", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const unlabeled = await listUnlabeledDocument("Mallory");

      await expect(
        attestProfileName({ ...CONFIG, profileSpace: unlabeled }, {
          loadPieces,
        }),
      ).rejects.toThrow(/is not one of .* own/);
    });
  });

  describe("renameProfile()", () => {
    it("stores the new name, which the list reads back", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await renameProfile(
        { ...CONFIG, profileSpace: ada.space, name: "  Countess  " },
        { loadPieces },
      );

      expect(await listedNames()).toEqual(["Countess"]);
    });

    it("refuses a blank name and leaves the stored one", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await expect(
        renameProfile({ ...CONFIG, profileSpace: ada.space, name: " " }, {
          loadPieces,
        }),
      ).rejects.toThrow(/needs a name/);
      expect(await listedNames()).toEqual(["Ada"]);
    });

    it("throws, leaving the stored name, when the profile refuses the rename", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      profileSigner = stranger;

      await expect(
        renameProfile({ ...CONFIG, profileSpace: ada.space, name: "Count" }, {
          loadPieces,
        }),
      ).rejects.toThrow(/^Renaming profile /);
      profileSigner = signer;
      expect(await listedNames()).toEqual(["Ada"]);
    });

    it("refuses a retired profile", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
        loadPieces,
      });
      await retireProfile({ ...CONFIG, profileSpace: alan.space }, {
        loadPieces,
      });

      await expect(
        renameProfile({ ...CONFIG, profileSpace: alan.space, name: "Count" }, {
          loadPieces,
        }),
      ).rejects.toThrow(/is retired/);
    });

    it("refuses a listed profile that is another identity's", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const theirs = await listStrangersProfile("Mallory");

      await expect(
        renameProfile({ ...CONFIG, profileSpace: theirs, name: "Count" }, {
          loadPieces,
        }),
      ).rejects.toThrow(/is not one of .* own/);
    });
  });

  describe("setProfilePicture()", () => {
    /** Gives `profile` the legacy avatar text `avatar`, through `setAvatar`. */
    async function setLegacyAvatar(
      profile: { space: string; id: string },
      avatar: string,
    ): Promise<void> {
      const pieces = await loadPieces({ ...CONFIG, space: profile.space });
      try {
        const piece = await pieces.getPieceCell(profile.id, true);
        const tx = pieces.runtime.edit();
        piece.withTx(tx).asSchema(undefined).key("setAvatar").send({ avatar });
        expect((await tx.commit().settled).error).toBeUndefined();
        await pieces.runtime.idle();
        await pieces.synced();
        await pieces.stopPiece(piece);
      } finally {
        await pieces.dispose();
      }
    }

    it("removes the legacy avatar text too with `clear`, since it shows where there is no picture", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      await setLegacyAvatar(ada, "data:image/png;base64,iVBORw0KGgo=");
      const [before] = await listProfiles(CONFIG, { loadPieces });
      expect(before.avatar).not.toBe("");
      expect(before.avatarByOwner).toBe(true);

      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, clear: true },
        { loadPieces },
      );
      const [listed] = await listProfiles(CONFIG, { loadPieces });
      expect(listed.avatar).toBe("");
      expect(listed.avatarByOwner).toBe(false);
      expect(listed.picture).toBeUndefined();
    });

    it("refuses a picture over `PROFILE_PICTURE_MAX_BYTES`, and stores nothing", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      const large = new Uint8Array(PROFILE_PICTURE_MAX_BYTES + 1);
      large.set(picture);

      await expect(
        setProfilePicture(
          { ...CONFIG, profileSpace: ada.space, bytes: large },
          { loadPieces },
        ),
      ).rejects.toThrow(/at most 262144 bytes/);
      expect((await listProfiles(CONFIG, { loadPieces }))[0].picture)
        .toBeUndefined();
    });

    it("stores the picture's bytes, which the list reads back, and removes them with `clear`", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, bytes: picture },
        { loadPieces },
      );
      const [set] = await listProfiles(CONFIG, { loadPieces });
      expect(set.picture).toEqual(picture);
      expect(set.pictureByOwner).toBe(true);

      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, clear: true },
        { loadPieces },
      );
      expect((await listProfiles(CONFIG, { loadPieces }))[0].picture)
        .toBeUndefined();
    });

    it("reports a picture another principal set as not the owner's", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      // The profile's space lets anyone write, and the picture's writer
      // labels the value with whoever wrote it.
      profileSigner = stranger;
      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, bytes: picture },
        { loadPieces },
      );
      profileSigner = signer;

      const [listed] = await listProfiles(CONFIG, { loadPieces });
      expect(listed.picture).toEqual(picture);
      expect(listed.pictureByOwner).toBe(false);

      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, bytes: picture },
        { loadPieces },
      );
      expect((await listProfiles(CONFIG, { loadPieces }))[0].pictureByOwner)
        .toBe(true);
    });

    it("reports a picture stored without a label as not attested to its owner, and attests it with `keepCurrent`", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      // A picture as a writer that brings no policy stores it: bytes, and no
      // label.
      const profile = runtime.getCellFromEntityId<{ picture?: unknown }>(
        spaceOf(ada),
        ada.id,
      );
      await profile.sync();
      const tx = runtime.edit();
      tx.writeValueOrThrow(
        profile.key("picture").resolveAsCell().getAsNormalizedFullLink(),
        new FabricBytes(picture),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();

      const [listed] = await listProfiles(CONFIG, { loadPieces });
      expect(listed.picture).toEqual(picture);
      expect(listed.pictureByOwner).toBe(false);

      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, keepCurrent: true },
        { loadPieces },
      );
      const [kept] = await listProfiles(CONFIG, { loadPieces });
      expect(kept.picture).toEqual(picture);
      expect(kept.pictureByOwner).toBe(true);
    });

    it("refuses `keepCurrent` for a profile with no picture, and stores none", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await expect(
        setProfilePicture(
          { ...CONFIG, profileSpace: ada.space, keepCurrent: true },
          { loadPieces },
        ),
      ).rejects.toThrow(/has no picture to set again/);
      expect((await listProfiles(CONFIG, { loadPieces }))[0].picture)
        .toBeUndefined();
    });

    it("refuses a listed profile that is another identity's", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const theirs = await listStrangersProfile("Mallory");

      await expect(
        setProfilePicture(
          { ...CONFIG, profileSpace: theirs, bytes: picture },
          { loadPieces },
        ),
      ).rejects.toThrow(/is not one of .* own/);
    });

    it("refuses bytes that are not a raster image, and leaves the picture", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await expect(
        setProfilePicture(
          {
            ...CONFIG,
            profileSpace: ada.space,
            bytes: new TextEncoder().encode("<svg/>"),
          },
          { loadPieces },
        ),
      ).rejects.toThrow(/PNG, JPEG/);
      expect((await listProfiles(CONFIG, { loadPieces }))[0].picture)
        .toBeUndefined();
    });
  });
});

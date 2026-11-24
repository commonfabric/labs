/**
 * A FabriChat room's file store, created by the room's `ensureFileStore`
 * handler and reached only through the link the room's record holds: a
 * session that reads the store's entries through the room gets them, and so
 * does a session that opens the room after the store exists. With server
 * execution on, the store's entries are a value only the serving loop
 * computes, and it computes them only for a piece it has started, so this is
 * the case of a piece reached only through a data link
 * (`docs/specs/server-side-execution/verification-coverage.md`, flag 4).
 *
 * The store takes adds from every member of the room's space, not only the
 * one whose runtime created it, and records each member as the adder of their
 * own files, with server execution on or off, whether or not the member's
 * client has opened the store. It refuses an add from a member whose home
 * lists no profile.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, describe, it } from "@std/testing/bdd";
import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";

import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-file-store",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** The record of a small image stored as `name`, as the blob store keeps it. */
const photo = (name: string) => ({
  type: "image/png",
  body: new FabricBytes(new Uint8Array([137, 80, 78, 71])),
  name,
});

/**
 * Makes `session`'s home list a profile of its own named `name`, as a home
 * made before any room is.
 */
const listOwnProfile = async (
  harness: MultiRuntimeHarness,
  session: MultiRuntimeSession,
  name: string,
): Promise<void> => {
  const profile = await session.createOwnProfile(name);
  await session.send("holdProfile", { profile });
  await harness.settle();
  await session.client().call("selectProfile", { path: ["profile"] });
  await harness.settle();
};

describe("fabrichat file store across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("lists the entries of a store the room reaches only through a link", async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["fabrichat-file-store-ada"],
    });
    const [ada] = harness.sessions;
    await ada.send("ensureFileStore", {});
    await harness.settleUntil(async () =>
      (await ada.read(["fileStore", "entries"])) !== undefined
    );
    expect(await ada.read(["fileStore", "entries"])).toEqual([]);

    // A session opening the room after the store exists reads it as well.
    const later = await harness.addSession("fabrichat-file-store-ada-later");
    await harness.settleUntil(async () =>
      (await later.read(["fileStore", "entries"])) !== undefined
    );
    expect(await later.read(["fileStore", "entries"])).toEqual([]);
  });

  for (const serverExecution of [false, true]) {
    describe(`with server execution ${serverExecution ? "on" : "off"}`, () => {
      const cfc = { experimental: { serverExecution } };

      /**
       * Opens the store in `session`'s runtime through `opened`, then adds the
       * file at `index` of the store's entries there, and checks that the
       * store took it with the profile named `adder` as its adder.
       */
      const expectAdd = async (
        session: MultiRuntimeSession,
        opened: { id: string; space: string },
        add: (
          session: MultiRuntimeSession,
          opened: { id: string; space: string } | undefined,
          requestId: string,
          name: string,
        ) => Promise<unknown>,
        index: number,
        adder: string,
      ) => {
        // The store runs in the runtime before the add arrives, as it does in
        // a client that shows the store's files.
        expect(await session.read(["entries", "length"], { piece: opened }))
          .toBe(index);
        await harness!.settle();

        const name = `file-${index}.png`;
        expect(await add(session, opened, `add-${index}`, name))
          .toMatchObject({ status: "done", name });
        expect(
          await session.read(["entries", index, "name"], { piece: opened }),
        ).toBe(name);
        expect(
          await session.read(["entries", index, "addedBy", "name"], {
            piece: opened,
          }),
        ).toBe(adder);
      };

      /**
       * A harness whose creator and member each have a profile of their own,
       * unless `memberProfile` is `false`, and a store the creator's runtime
       * alone created, as one member's client does in a room, with a file the
       * creator added unless `creatorAdds` is `false`. Returns the harness's
       * sessions, the member's identity, the store, the link the room's record
       * holds to it, and the means to add a file to it.
       */
      const storeTheCreatorMade = async (
        { creatorAdds = true, memberProfile = true } = {},
      ) => {
        const creatorIdentity = await Identity.fromPassphrase(
          "fabrichat-file-store-creator",
          { implementation: "noble" },
        );
        const memberIdentity = await Identity.fromPassphrase(
          "fabrichat-file-store-member",
          { implementation: "noble" },
        );
        harness = await MultiRuntimeHarness.create({
          programPath: PROGRAM_PATH,
          rootPath: ROOT_PATH,
          sessions: [
            {
              label: "fabrichat-file-store-creator",
              identity: creatorIdentity,
              cfc,
            },
            {
              label: "fabrichat-file-store-member",
              identity: memberIdentity,
              cfc,
            },
          ],
          aclMode: "enforce",
        });
        const [creator, member] = harness.sessions;
        await listOwnProfile(harness, creator, "Creator");
        if (memberProfile) await listOwnProfile(harness, member, "Member");

        await creator.send("ensureFileStore", {});
        await harness.settleUntil(async () =>
          (await creator.read(["fileStore", "entries"])) !== undefined
        );
        const store = await creator.link(["fileStore"]);
        const { space } = store;
        const record = await creator.link(["fileStoreRecord"]);
        const { value: slot } = await creator.rawRead({
          ...record,
          path: ["value", "store", "/", "link@1", "id"],
        });
        expect(typeof slot).toBe("string");

        // Adds a file whose bytes the store's space holds, as the room's
        // composer does, and returns the store's outcome as `session` reads
        // it through `opened`, or through the room where `opened` is
        // `undefined`, which leaves the store unopened in `session`.
        const add = async (
          session: MultiRuntimeSession,
          opened: { id: string; space: string } | undefined,
          requestId: string,
          name: string,
        ) => {
          const outcome = () =>
            opened === undefined
              ? session.read(["fileStore", "requests", requestId])
              : session.read(["requests", requestId], { piece: opened });
          const blob = photo(name);
          const id = hashOf(blob).toString();
          await session.rawWrite({ id: `cid:${id}`, space }, { value: blob });
          await session.send("addToStore", {
            requestId,
            name,
            mediaType: blob.type,
            blob: { space, id },
            size: 4,
          });
          await harness!.settleUntil(async () =>
            (await outcome()) !== undefined
          );
          return await outcome();
        };
        if (creatorAdds) await expectAdd(creator, store, add, 0, "Creator");
        return {
          creator,
          member,
          memberIdentity,
          store,
          slot: { id: slot as string, space },
          add,
        };
      };

      it("takes an add from a member who opened the store by its own id, recording that member as its adder", async () => {
        const { member, store, add } = await storeTheCreatorMade();

        await expectAdd(member, store, add, 1, "Member");
      });

      it("settles a creator's requests read when a member's profile is private", async () => {
        const { creator, member, store, add } = await storeTheCreatorMade();
        await expectAdd(member, store, add, 1, "Member");
        await harness!.settle();

        const memberProfile = await member.link(
          ["entries", 1, "addedBy"],
          { piece: store },
        );
        expect(await creator.read(["requests"], { piece: store }))
          .toMatchObject({
            "add-0": { status: "done", name: "file-0.png" },
          });
        expect(await creator.spaceRefused(memberProfile.space)).toBe(true);
        expect(
          await creator.read(["entries", 1, "addedBy", "name"], {
            piece: store,
          }),
        ).toBeUndefined();

        // A reader asking for the outcomes alone does not need the profiles
        // the entries link to, so both members' outcomes remain readable.
        expect(
          await creator.readAs(["requests"], {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                status: { type: "string" },
                name: { type: "string" },
              },
              required: ["status", "name"],
              additionalProperties: false,
            },
          }, { piece: store }),
        ).toEqual({
          "add-0": { status: "done", name: "file-0.png" },
          "add-1": { status: "done", name: "file-1.png" },
        });
      });

      it("takes an add from a member who opened the store through the link the room holds, recording that member as its adder", async () => {
        const { member, slot, add } = await storeTheCreatorMade();

        await expectAdd(member, slot, add, 1, "Member");
      });

      it("takes an add from a second runtime of a member, which opened the store after the member's first runtime did", async () => {
        const { member, memberIdentity, store, add } =
          await storeTheCreatorMade();
        expect(await member.read(["entries", "length"], { piece: store }))
          .toBe(1);

        const again = await harness!.addSession({
          label: "fabrichat-file-store-member-again",
          identity: memberIdentity,
          cfc,
        });
        await expectAdd(again, store, add, 1, "Member");
      });

      /**
       * Adds a file as `session`, which has never opened the store, and checks
       * through the room that the store took it as the entry at `index`, with
       * the profile named `adder` as its adder.
       */
      const expectUnopenedAdd = async (
        session: MultiRuntimeSession,
        add: Awaited<ReturnType<typeof storeTheCreatorMade>>["add"],
        index: number,
        adder: string,
      ) => {
        const name = `file-${index}.png`;
        expect(await add(session, undefined, `add-${index}`, name))
          .toMatchObject({ status: "done", name });
        expect(
          await session.read([
            "fileStore",
            "entries",
            index,
            "addedBy",
            "name",
          ]),
        ).toBe(adder);
      };

      it("takes the first add of the creator, whose client has never opened the store", async () => {
        const { creator, add } = await storeTheCreatorMade({
          creatorAdds: false,
        });

        await expectUnopenedAdd(creator, add, 0, "Creator");
      });

      it("takes the first add of a member to a store no client has opened", async () => {
        const { member, add } = await storeTheCreatorMade({
          creatorAdds: false,
        });

        await expectUnopenedAdd(member, add, 0, "Member");
      });

      it("refuses the first add of a member whose home lists no profile, as having no profile", async () => {
        const { member, add } = await storeTheCreatorMade({
          creatorAdds: false,
          memberProfile: false,
        });

        expect(await add(member, undefined, "add-0", "file-0.png"))
          .toMatchObject({
            status: "refused",
            code: "not-permitted",
            reason: "You have no profile yet.",
          });
      });

      it("takes the first add of a member, whose client has never opened the store", async () => {
        const { member, add } = await storeTheCreatorMade();

        await expectUnopenedAdd(member, add, 1, "Member");
      });
    });
  }
});

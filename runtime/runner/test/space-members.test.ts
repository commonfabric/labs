import { expect } from "@std/expect";

import type { DID, SpaceMemberList } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Cell } from "../src/cell.ts";
import { joinSpaceMembers, spaceMembersAt } from "../src/space-members.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const alice = await Identity.fromPassphrase("space-members alice");
const bob = await Identity.fromPassphrase("space-members bob");
const carol = await Identity.fromPassphrase("space-members carol");
const dave = await Identity.fromPassphrase("space-members dave");
const space: MemorySpace = alice.did();

describe("space-members", () => {
  describe("joinSpaceMembers()", () => {
    // A profile here is a plain record naming its owner, and its key is its
    // `key`, so each case states whose each profile is and which are one.

    /** A profile owned by `owner`, which is one with any other of `key`. */
    interface Profile {
      owner?: DID;
      key?: string;
    }

    const ownerOf = (profile: Profile) => profile.owner;
    const keyOf = (profile: Profile) => profile.key;

    /** The list naming each of `entries`, and `anyone` if given. */
    const listOf = (
      entries: [Identity, "OWNER" | "WRITE" | "READ"][],
      anyone?: "OWNER" | "WRITE" | "READ",
    ): SpaceMemberList => {
      const principals = Object.fromEntries(
        entries.map(([who, level]) => [who.did(), level]),
      );
      return anyone === undefined ? { principals } : { principals, anyone };
    };

    it("returns one member for each principal the list names, sorted by DID, with its level", () => {
      const members = joinSpaceMembers(
        [],
        listOf([[carol, "READ"], [alice, "OWNER"], [bob, "WRITE"]]),
        ownerOf,
        keyOf,
      );

      const expected = [
        { principal: alice.did(), level: "OWNER" },
        { principal: bob.did(), level: "WRITE" },
        { principal: carol.did(), level: "READ" },
      ].sort((a, b) => a.principal < b.principal ? -1 : 1)
        .map((member) => ({ ...member, profiles: [] }));
      expect(members).toStrictEqual(expected);
    });

    it("adds no member for the list's `anyone`", () => {
      expect(
        joinSpaceMembers([], listOf([], "WRITE"), ownerOf, keyOf),
      ).toStrictEqual([]);
      expect(
        joinSpaceMembers(
          [{ owner: dave.did(), key: "dave" }],
          listOf([[alice, "OWNER"]], "WRITE"),
          ownerOf,
          keyOf,
        )?.map(({ principal }) => principal),
      ).toStrictEqual([alice.did()]);
    });

    it("gives each member their own profiles in roster order, and none to a member with none", () => {
      const work = { owner: alice.did(), key: "alice at work" };
      const home = { owner: alice.did(), key: "alice" };
      const members = joinSpaceMembers(
        [work, { owner: bob.did(), key: "bob" }, home],
        listOf([[alice, "OWNER"], [bob, "WRITE"], [carol, "READ"]]),
        ownerOf,
        keyOf,
      );

      const profilesOf = (who: Identity) =>
        members?.find(({ principal }) => principal === who.did())?.profiles;
      expect(profilesOf(alice)).toStrictEqual([work, home]);
      expect(profilesOf(bob)).toStrictEqual([{ owner: bob.did(), key: "bob" }]);
      expect(profilesOf(carol)).toStrictEqual([]);
    });

    it("leaves out a profile that is no one's, and one whose owner the list does not name", () => {
      const members = joinSpaceMembers(
        [{ key: "nobody" }, { owner: dave.did(), key: "dave" }],
        listOf([[alice, "OWNER"]]),
        ownerOf,
        keyOf,
      );

      expect(members).toStrictEqual([
        { principal: alice.did(), level: "OWNER", profiles: [] },
      ]);
    });

    it("counts two profiles with one key once, where the roster first lists it", () => {
      const first = { owner: alice.did(), key: "alice" };
      const again = { owner: alice.did(), key: "alice" };
      const other = { owner: alice.did(), key: "alice at work" };
      const members = joinSpaceMembers(
        [first, other, again, other],
        listOf([[alice, "OWNER"]]),
        ownerOf,
        keyOf,
      );

      expect(members?.[0].profiles).toHaveLength(2);
      expect(members?.[0].profiles[0]).toBe(first);
      expect(members?.[0].profiles[1]).toBe(other);
    });

    it("counts a profile with no key once, and as distinct from every other", () => {
      const unkeyed = { owner: alice.did() };
      const twin = { owner: alice.did() };
      const members = joinSpaceMembers(
        [unkeyed, twin, unkeyed],
        listOf([[alice, "OWNER"]]),
        ownerOf,
        keyOf,
      );

      expect(members?.[0].profiles).toHaveLength(2);
      expect(members?.[0].profiles[0]).toBe(unkeyed);
      expect(members?.[0].profiles[1]).toBe(twin);
    });

    it("returns `undefined` for a list of `undefined`, and `[]` for a list naming no one", () => {
      const roster = [{ owner: alice.did(), key: "alice" }];

      expect(joinSpaceMembers(roster, undefined, ownerOf, keyOf))
        .toBeUndefined();
      expect(joinSpaceMembers(roster, listOf([]), ownerOf, keyOf))
        .toStrictEqual([]);
    });
  });

  describe("spaceMembersAt()", () => {
    let runtime: Runtime;
    let storage: ReturnType<typeof StorageManager.emulate>;
    let openTxs: IExtendedStorageTransaction[];

    beforeEach(() => {
      openTxs = [];
      storage = StorageManager.emulate({ as: alice });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
    });

    afterEach(async () => {
      for (const tx of openTxs) tx.abort(new Error("test-only"));
      await runtime.idle();
      await runtime.dispose();
      await storage.close();
    });

    /** Returns a transaction the test aborts once it is done. */
    const readTx = (): IExtendedStorageTransaction => {
      const tx = runtime.edit();
      openTxs.push(tx);
      return tx;
    };

    /**
     * Stores `value` in the document `cause` names, with a root label
     * claiming it represents `owner` if given, and returns its cell.
     */
    const seed = async (
      cause: string,
      value: FabricValue,
      owner?: Identity,
    ): Promise<Cell<unknown>> => {
      const id = runtime.getCell(space, cause).getAsNormalizedFullLink().id;
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, { space, scope: "space", id, path: [] }, {
        value,
        ...(owner === undefined ? {} : {
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: {
                  integrity: [{
                    kind: "represents-principal",
                    subject: owner.did(),
                  }],
                },
                origin: "declared",
              }],
            },
          },
        }),
      });
      expect((await tx.commit().settled).error).toBeUndefined();
      return runtime.getCell(space, cause);
    };

    /** Stores `acl` as the space's access list. */
    const storeAcl = async (acl: Record<string, string>): Promise<void> => {
      const tx = runtime.edit();
      seedStoredEnvelope(
        tx,
        { space, scope: "space", id: aclDocId(space) as URI, path: [] },
        { value: acl },
      );
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    it("returns each member with the roster's profiles of their own, and none for a member with none", async () => {
      await storeAcl({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
        "*": "READ",
      });
      const profile = await seed("alice profile", { name: "Alice" }, alice);
      const unclaimed = await seed("unclaimed profile", { name: "Nobody" });
      const outsider = await seed("dave profile", { name: "Dave" }, dave);

      const members = spaceMembersAt(runtime, readTx(), space, [
        unclaimed,
        profile,
        outsider,
        runtime.getCell(space, "alice profile"),
      ]);

      expect(members?.map(({ principal, level }) => ({ principal, level })))
        .toStrictEqual(
          [
            { principal: alice.did(), level: "OWNER" },
            { principal: bob.did(), level: "WRITE" },
          ].sort((a, b) => a.principal < b.principal ? -1 : 1),
        );
      const own = members?.find(({ principal }) => principal === alice.did())
        ?.profiles;
      expect(own).toHaveLength(1);
      expect(own?.[0].equals(profile)).toBe(true);
      expect(
        members?.find(({ principal }) => principal === bob.did())?.profiles,
      ).toStrictEqual([]);
    });

    it("returns `undefined` for a space with no access list", async () => {
      const profile = await seed("alice profile", { name: "Alice" }, alice);

      expect(spaceMembersAt(runtime, readTx(), space, [profile]))
        .toBeUndefined();
    });

    it("returns `undefined` for an access list that is not a well-formed list", async () => {
      await storeAcl({ [alice.did()]: "SOMETIMES" });

      expect(spaceMembersAt(runtime, readTx(), space, [])).toBeUndefined();
    });
  });
});

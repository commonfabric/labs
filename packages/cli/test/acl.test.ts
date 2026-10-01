/**
 * Unit tests for the ACL library functions. Each takes the connection as a
 * parameter, so a stub controller carrying a stub runtime is enough to drive
 * the whole read-mutate-write cycle: nothing here builds a runtime, opens a
 * socket, or reaches a server.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { ACL } from "@commonfabric/memory/acl";
import type { PiecesController } from "@commonfabric/piece/ops";

import { getAcl, leaveAcl, removeAclEntry, setAclEntry } from "../lib/acl.ts";
import type { SpaceConfig } from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";
const OWNER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const GUEST = "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";

const config: SpaceConfig = {
  apiUrl: "http://localhost:8000",
  space: SPACE,
  identity: "/nonexistent/keyfile",
};

const stored: ACL = { [OWNER]: "OWNER" };

/** What a call did to the connection it was handed. */
interface Connection {
  /** The configuration the loader was asked for a session with. */
  requested?: SpaceConfig & { deferSpaceCellSync?: boolean };

  /** Every ACL document written, in the order they were written. */
  written: ACL[];

  /** Whether the runtime behind the connection was disposed. */
  disposed: boolean;

  /** The `PiecesController` seam a call is given. */
  pieces: PiecesController;
}

/**
 * A connection over `acl`, or over a space with no ACL document where that is
 * `undefined`, acting as `principal`. `authorizationError` is what the space
 * reports once the ACL access has pulled it, or, when `afterWrite` is set,
 * only once an ACL document has been written, as a session revoked by its own
 * write would.
 */
function connection(
  acl: ACL | undefined,
  authorizationError?: Error,
  { principal = OWNER, afterWrite = false } = {},
): Connection {
  const result: Connection = {
    written: [],
    disposed: false,
    pieces: undefined as unknown as PiecesController,
  };
  const runtime = {
    getCellFromLink: () => ({
      sync: () => Promise.resolve(),
      get: () => acl,
    }),
    userIdentityDID: principal,
    storageManager: {
      synced: () => Promise.resolve(),
      authorizationError: () =>
        afterWrite && result.written.length === 0
          ? undefined
          : authorizationError,
    },
    editWithRetry: (body: (tx: unknown) => ACL) => {
      const tx = {
        readOrThrow: () => acl === undefined ? undefined : { value: acl },
        writeOrThrow: (_address: unknown, envelope: { value: ACL }) => {
          result.written.push(envelope.value);
        },
      };
      return Promise.resolve({ ok: body(tx) });
    },
    idle: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => {
      result.disposed = true;
      return Promise.resolve();
    },
  };
  result.pieces = {
    runtime,
    getSpace: () => SPACE,
  } as unknown as PiecesController;
  return result;
}

/** The seam under test: a held connection, recording what it was asked for. */
function over(held: Connection) {
  return {
    loadPieces: (requested: SpaceConfig) => {
      held.requested = requested;
      return Promise.resolve(held.pieces);
    },
  };
}

describe("acl", () => {
  describe("getAcl()", () => {
    it("returns the ACL the space holds", async () => {
      const held = connection(stored);
      expect(await getAcl(config, over(held))).toEqual(stored);
    });

    it("returns `null` for a space with no ACL document", async () => {
      const held = connection(undefined);
      expect(await getAcl(config, over(held))).toBeNull();
    });

    it("opens the space with the space cell's sync deferred", async () => {
      // The ACL document is addressed by the space DID and read through the
      // `ACLManager`, so the space cell's contents are never needed.

      const held = connection(stored);
      await getAcl(config, over(held));
      expect(held.requested).toEqual({ ...config, deferSpaceCellSync: true });
    });

    it("leaves the connection it was handed open", async () => {
      // Disposing here would close a runtime, a storage manager and a socket
      // that the caller holds for its next call.

      const held = connection(stored);
      await getAcl(config, over(held));
      expect(held.disposed).toBe(false);
    });

    it("throws the denial the space recorded during the read", async () => {
      const denied = new Error("not authorized for this space");
      const held = connection(stored, denied);
      await expect(getAcl(config, over(held))).rejects.toThrow(denied);
    });

    it("names no write for a read", async () => {
      // A receipt is a claim that the space changed, and reading an ACL
      // changes nothing in it.

      resetWriteReceipts();
      const held = connection(stored);
      const lines = await captureStderr(async () => {
        await getAcl(config, over(held));
      });
      expect(lines).toEqual([]);
    });
  });

  describe("setAclEntry()", () => {
    it("writes the ACL with the new entry beside the existing ones", async () => {
      resetWriteReceipts();
      const held = connection(stored);
      const lines = await captureStderr(() =>
        setAclEntry(config, GUEST, "READ", over(held))
      );
      expect(held.written).toEqual([{ [OWNER]: "OWNER", [GUEST]: "READ" }]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("maps `ANYONE` to the wildcard principal", async () => {
      resetWriteReceipts();
      const held = connection(stored);
      await captureStderr(() =>
        setAclEntry(config, "ANYONE", "READ", over(held))
      );
      expect(held.written).toEqual([{ [OWNER]: "OWNER", "*": "READ" }]);
    });

    it("throws for a principal that is neither `ANYONE` nor a DID", async () => {
      const held = connection(stored);
      await expect(setAclEntry(config, "mike", "READ", over(held)))
        .rejects.toThrow('mike is not "ANYONE" or a valid DID.');
      expect(held.written).toEqual([]);
    });
  });

  describe("removeAclEntry()", () => {
    it("writes the ACL without the entry", async () => {
      resetWriteReceipts();
      const held = connection({ ...stored, [GUEST]: "READ" });
      const lines = await captureStderr(() =>
        removeAclEntry(config, GUEST, over(held))
      );
      expect(held.written).toEqual([{ [OWNER]: "OWNER" }]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("throws for a space with no ACL document", async () => {
      const held = connection(undefined);
      await expect(removeAclEntry(config, GUEST, over(held)))
        .rejects.toThrow("No ACL initialized for space.");
      expect(held.written).toEqual([]);
    });
  });

  describe("leaveAcl()", () => {
    it('writes the ACL without the identity\'s own entry, and returns `"left"`', async () => {
      resetWriteReceipts();
      const held = connection({ ...stored, [GUEST]: "WRITE" }, undefined, {
        principal: GUEST,
      });
      let outcome: unknown;
      const lines = await captureStderr(async () => {
        outcome = await leaveAcl(config, over(held));
      });
      expect(outcome).toBe("left");
      expect(held.written).toEqual([{ [OWNER]: "OWNER" }]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it('returns `"left"` past the denial the space records after the identity\'s own removal', async () => {
      // The memory server revokes the session of a principal that has lost
      // access, and the session records that as a denial.

      const held = connection(
        { ...stored, [GUEST]: "WRITE" },
        new Error("memory session revoked: unauthorized"),
        { principal: GUEST, afterWrite: true },
      );
      let outcome: unknown;
      await captureStderr(async () => {
        outcome = await leaveAcl(config, over(held));
      });
      expect(outcome).toBe("left");
    });

    it("throws the denial the space recorded during the read, writing nothing", async () => {
      const denied = new Error("not authorized for this space");
      const held = connection({ ...stored, [GUEST]: "WRITE" }, denied, {
        principal: GUEST,
      });
      await expect(leaveAcl(config, over(held))).rejects.toThrow(denied);
      expect(held.written).toEqual([]);
    });

    it('returns `"absent"`, writing nothing, for an identity the ACL holds no entry for', async () => {
      const held = connection(stored, undefined, { principal: GUEST });
      expect(await leaveAcl(config, over(held))).toBe("absent");
      expect(held.written).toEqual([]);
    });

    it("throws, writing nothing, for an ACL with a `*` entry", async () => {
      const held = connection(
        { ...stored, [GUEST]: "WRITE", "*": "READ" },
        undefined,
        {
          principal: GUEST,
        },
      );
      await expect(leaveAcl(config, over(held))).rejects.toThrow(
        'has a "*" entry, which would go on granting',
      );
      expect(held.written).toEqual([]);
    });

    for (
      const [description, acl] of [
        ["beside other members", { [OWNER]: "OWNER", [GUEST]: "WRITE" }],
        ["as the ACL's only entry", { [OWNER]: "OWNER" }],
      ] as const
    ) {
      it(`throws, writing nothing, for the last concrete \`OWNER\` ${description}`, async () => {
        const held = connection(acl, undefined, { principal: OWNER });
        await expect(leaveAcl(config, over(held))).rejects.toThrow(
          "is the last concrete OWNER",
        );
        expect(held.written).toEqual([]);
      });
    }

    it("throws for a space with no ACL document", async () => {
      const held = connection(undefined, undefined, { principal: GUEST });
      await expect(leaveAcl(config, over(held)))
        .rejects.toThrow("No ACL initialized for space.");
      expect(held.written).toEqual([]);
    });
  });
});

/**
 * Unit tests for the `cf acl` subcommands, parsed as a person types them and
 * run over a real runtime on emulated storage. The command writes its output
 * through `Deno.stdout`, which each case captures, so this file runs serially.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";

import { createSession, Identity } from "@commonfabric/identity";
import type { ACL, ACLUser, Capability } from "@commonfabric/memory/acl";
import { PiecesController } from "@commonfabric/piece/ops";
import { ACLManager, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { decode } from "@commonfabric/text/utf8";

import { aclCommand } from "../commands/acl.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const GUEST = "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";
const OTHER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("acl-command", () => {
  let me: Identity;
  let space: `did:${string}:${string}`;
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let pieces: PiecesController;

  beforeEach(async () => {
    me = await Identity.fromPassphrase("cli acl command tests");
    space = (await Identity.generate()).did();
    storageManager = StorageManager.emulate({ as: me });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    pieces = new PiecesController(
      createSession({ identity: me, spaceDid: space }),
      runtime,
    );
    resetWriteReceipts();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Writes `entries` into the space's access list, in order. */
  async function seed(...entries: [ACLUser, Capability][]): Promise<void> {
    const manager = new ACLManager(runtime, space);
    for (const [user, capability] of entries) {
      await manager.set(user, capability);
    }
  }

  /** Returns the access list the space now holds. */
  async function stored(): Promise<ACL | null> {
    return await new ACLManager(runtime, space).get();
  }

  /**
   * Parses `args` after `cf acl`, with the connection flags appended, and
   * returns what the command wrote to stdout.
   */
  async function run(...args: string[]): Promise<string> {
    const chunks: string[] = [];
    const write = Deno.stdout.writeSync;
    Deno.stdout.writeSync = (bytes: Uint8Array) => {
      chunks.push(decode(bytes));
      return bytes.length;
    };
    try {
      await captureStderr(async () => {
        await aclCommand({ loadPieces: () => Promise.resolve(pieces) })
          .reset()
          .throwErrors()
          .parse([
            ...args,
            "--identity",
            "/keys/me.key",
            "--api-url",
            "https://toolshed.test",
            "--space",
            space,
          ]);
      });
    } finally {
      Deno.stdout.writeSync = write;
    }
    return chunks.join("");
  }

  describe("ls", () => {
    it("prints that there are no entries for a space with no access list", async () => {
      expect(await run("ls")).toBe("No ACL entries found.\n");
    });

    it("prints a table row for each entry", async () => {
      await seed([me.did(), "OWNER"], [GUEST, "READ"]);

      const lines = (await run("ls")).split("\n");

      expect(lines.some((l) => l.includes("DID") && l.includes("CAPABILITY")))
        .toBe(true);
      expect(lines.some((l) => l.includes(me.did()) && l.includes("OWNER")))
        .toBe(true);
      expect(lines.some((l) => l.includes(GUEST) && l.includes("READ")))
        .toBe(true);
      expect(lines.some((l) => l.includes(GUEST) && l.includes("OWNER")))
        .toBe(false);
    });
  });

  describe("set", () => {
    it("writes the entry at the capability given in any case, and prints it", async () => {
      await seed([me.did(), "OWNER"]);

      expect(await run("set", GUEST, "write")).toBe(
        `Added ${GUEST} with WRITE capability\n`,
      );
      expect(await stored()).toEqual({ [me.did()]: "OWNER", [GUEST]: "WRITE" });
    });

    it("throws for a capability that is not one of the three, writing nothing", async () => {
      await seed([me.did(), "OWNER"]);

      const refused = run("set", GUEST, "ADMIN");

      await expect(refused).rejects.toThrow(ValidationError);
      await expect(refused).rejects.toThrow(
        "Invalid capability: ADMIN. Must be one of: READ, WRITE, OWNER",
      );
      expect(await stored()).toEqual({ [me.did()]: "OWNER" });
    });
  });

  describe("remove", () => {
    it("writes the access list without the entry, and prints that", async () => {
      await seed([me.did(), "OWNER"], [GUEST, "READ"]);

      expect(await run("remove", GUEST)).toBe(`Removed ${GUEST} from ACL\n`);
      expect(await stored()).toEqual({ [me.did()]: "OWNER" });
    });
  });

  describe("leave", () => {
    it("writes the access list without the identity's own entry, and prints that it left", async () => {
      await seed([me.did(), "OWNER"], [OTHER, "OWNER"], [me.did(), "WRITE"]);

      expect(await run("leave")).toBe(`Left ${space}\n`);
      expect(await stored()).toEqual({ [OTHER]: "OWNER" });
    });

    it("prints that there is nothing to leave for an identity the list does not name", async () => {
      await seed([me.did(), "OWNER"], [OTHER, "OWNER"]);
      await new ACLManager(runtime, space).remove(me.did());

      expect(await run("leave")).toBe(
        `Not in the ACL of ${space}; nothing to leave\n`,
      );
      expect(await stored()).toEqual({ [OTHER]: "OWNER" });
    });
  });
});

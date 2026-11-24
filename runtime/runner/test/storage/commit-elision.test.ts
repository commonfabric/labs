import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { resolveScopeKey } from "@commonfabric/memory/v2";

import {
  recordCommitElisions,
  wasCommitWriteElided,
} from "../../src/storage/commit-elision.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("commit-elision");
const space: MemorySpace = signer.did();
const identity = { principal: signer.did() };

describe("commit-elision", () => {
  describe("recordCommitElisions()", () => {
    it("skips a non-document operation without shifting the wire indexes of the documents after it", async () => {
      const storage = EmulatedStorageManager.emulate({ as: signer });
      try {
        const source = storage.edit();
        recordCommitElisions(
          source,
          space,
          [
            { op: "sqlite", db: { id: "of:db" }, sql: "DELETE FROM t" },
            { op: "delete", id: "of:elided" },
            { op: "delete", id: "of:written" },
          ],
          [0, 1],
          identity,
        );

        const document = (id: string) => ({
          space,
          id,
          scopeKey: resolveScopeKey("space", identity),
        });
        expect(wasCommitWriteElided(source, document("of:elided"))).toBe(true);
        expect(wasCommitWriteElided(source, document("of:written"))).toBe(
          false,
        );
        expect(wasCommitWriteElided(source, document("of:db"))).toBe(false);
      } finally {
        await storage.close();
      }
    });
  });
});

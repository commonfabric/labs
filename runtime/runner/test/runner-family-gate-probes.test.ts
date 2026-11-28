/**
 * The probes a named family's gate runs before the family runs without a
 * name-sync of its own: whether an absence it read is one the replica never
 * examined, and whether a document the argument links to is absent.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("runner family gate probes");
const space = signer.did();

describe("Runner's named-family gate probes", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  describe("absenceUnexamined()", () => {
    const sessionCell: NormalizedFullLink = {
      space,
      id: "of:family-gate-session-cell",
      path: [],
      scope: "session",
    };

    it("counts an absence unexamined where the family's identity cannot resolve its instance", () => {
      const probes = runtime.runner.accessForTestingOnly;
      const sessionless = runtime.readTx();
      sessionless.tx.scopeKeyIdentity = { principal: signer.did() };
      expect(probes.absenceUnexamined(sessionless, [sessionCell])).toBe(true);

      const inSession = runtime.readTx();
      inSession.tx.scopeKeyIdentity = {
        principal: signer.did(),
        sessionId: "a session",
      };
      expect(probes.absenceUnexamined(inSession, [sessionCell])).toBe(false);
    });
  });

  describe("argumentLinksAbsent()", () => {
    /**
     * Writes a chain of `length` documents, each holding a redirect to the
     * next, the last redirecting to a document no one wrote, and returns the
     * chain's documents followed by that absent one.
     */
    async function redirectChain(
      name: string,
      length: number,
    ): Promise<Cell<unknown>[]> {
      const cells = Array.from(
        { length: length + 1 },
        (_, hop) => runtime.getCell<unknown>(space, `${name} ${hop}`),
      );
      const tx = runtime.edit();
      for (let hop = 0; hop < length; hop++) {
        cells[hop].withTx(tx).setRaw(cells[hop + 1].getAsWriteRedirectLink());
      }
      expect((await tx.commit().settled).error).toBeUndefined();
      return cells;
    }

    /**
     * Whether the probe finds a document absent that the argument
     * `{ value: <redirect to chain[0]> }` links to, and the ids it probed.
     */
    function probe(
      chain: Cell<unknown>[],
    ): { absent: boolean; probed: string[] } {
      const resultCell = runtime.getCell(space, "family gate result");
      const argumentCell = runtime.getCell(space, "family gate argument");
      const written = new Set(
        chain.slice(0, -1).map((cell) => cell.getAsNormalizedFullLink().id),
      );
      const probed: string[] = [];
      const absent = runtime.runner.accessForTestingOnly.argumentLinksAbsent(
        { value: chain[0].getAsWriteRedirectLink() },
        argumentCell.getAsNormalizedFullLink(),
        resultCell,
        runtime.readTx(),
        (link) => {
          probed.push(link.id);
          return written.has(link.id);
        },
      );
      return { absent, probed };
    }

    it("finds a document absent at the end of a redirect chain of four hops", async () => {
      const chain = await redirectChain("four hops", 4);
      const ids = chain.map((cell) => cell.getAsNormalizedFullLink().id);

      expect(probe(chain)).toEqual({ absent: true, probed: ids });
    });

    it("walks a redirect chain no further than five documents", async () => {
      const chain = await redirectChain("five hops", 5);
      const ids = chain.map((cell) => cell.getAsNormalizedFullLink().id);

      expect(probe(chain)).toEqual({ absent: false, probed: ids.slice(0, 5) });
    });
  });
});

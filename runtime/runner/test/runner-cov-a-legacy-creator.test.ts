import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { fabricFromConvertibleJsValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import { getMetaLink } from "../src/link-utils.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const alice = await Identity.fromPassphrase("runner legacy creator alice");
const bob = await Identity.fromPassphrase("runner legacy creator bob");
const space: MemorySpace = alice.did();

/**
 * A release from before the runtime recorded creators: a note list the acting
 * principal owns, which its one writer, `note`, adds to.
 */
const LEGACY_RELEASE = `/// <cts-enable />
import {
  Cfc,
  CurrentPrincipal,
  Default,
  handler,
  pattern,
  RepresentsCurrentUser,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
const note = handler<{ add: string }, { notes: Writable<string[]> }>(
  (event, { notes }) => {
    notes.set([...notes.get(), event.add]);
  },
);
type Notes = RepresentsCurrentUser<
  Cfc<WriteAuthorizedBy<string[], typeof note>, { ownerPrincipal: CurrentPrincipal }>
>;
export default pattern<{ notes: Writable<Default<Notes, []>> }>(
  ({ notes }) => ({ notes, note: note({ notes }) }),
);
`;

/** The legacy release's successor: the same notes, and the owned list `items`. */
const LEGACY_SECOND_RELEASE = `/// <cts-enable />
import {
  Cfc,
  CurrentPrincipal,
  Default,
  handler,
  pattern,
  RepresentsCurrentUser,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
const note = handler<{ add: string }, { notes: Writable<string[]> }>(
  (event, { notes }) => {
    notes.set([...notes.get(), event.add]);
  },
);
const edit = handler<{ add: string }, { items: Writable<string[]> }>(
  (event, { items }) => {
    items.set([...items.get(), event.add]);
  },
);
type Notes = RepresentsCurrentUser<
  Cfc<WriteAuthorizedBy<string[], typeof note>, { ownerPrincipal: CurrentPrincipal }>
>;
type Items = RepresentsCurrentUser<
  Cfc<WriteAuthorizedBy<string[], typeof edit>, { ownerPrincipal: CurrentPrincipal }>
>;
export default pattern<{
  notes: Writable<Default<Notes, []>>;
  items: Writable<Default<Items, []>>;
}>(({ notes, items }) => ({
  notes,
  items,
  note: note({ notes }),
  add: edit({ items }),
}));
`;

describe("runner", () => {
  describe("creator of a piece with no record at its next source transition", () => {
    let server: ReturnType<typeof newLoopbackServer>;
    let managers: EmulatedStorageManager[];
    let runtimes: Runtime[];

    const connect = (as: Identity, pieceCreatorRecord: boolean): Runtime => {
      const storageManager = EmulatedStorageManager.connectTo(server, { as });
      managers.push(storageManager);
      const runtime = new Runtime({
        apiUrl: new URL("https://fabric.example/"),
        storageManager,
        experimental: { pieceCreatorRecord },
      });
      runtimes.push(runtime);
      return runtime;
    };

    const compile = (runtime: Runtime, source: string) =>
      runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      }, { space });

    beforeEach(() => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      managers = [];
      runtimes = [];
    });

    afterEach(async () => {
      for (const runtime of runtimes) {
        await runtime.idle();
        await runtime.dispose();
      }
      for (const manager of managers) await manager.close();
      await server.close();
    });

    /**
     * Creates a piece of the legacy release on a runtime that records no
     * creator, and puts `extra` in front of its internal-cell manifest.
     */
    const createLegacyPiece = async (
      extra: unknown[],
    ): Promise<NormalizedFullLink> => {
      const legacy = connect(alice, false);
      const compiled = await compile(legacy, LEGACY_RELEASE);
      const result = legacy.getCell(space, "legacy", compiled.resultSchema);
      const tx = legacy.edit();
      legacy.run(tx, compiled, {}, result);
      expect((await tx.commit().settled).error).toBeUndefined();
      const edit = legacy.edit();
      const manifest = result.withTx(edit).getMetaRaw("internal");
      expect(Array.isArray(manifest)).toBe(true);
      result.withTx(edit).setMetaRaw(
        "internal",
        [
          ...extra.map((entry) => fabricFromConvertibleJsValue(entry as never)),
          ...(manifest as unknown[]),
        ] as never,
        rawMetaWriteAuthorization,
      );
      expect((await edit.commit().settled).error).toBeUndefined();
      await legacy.storageManager.synced();
      return result.getAsNormalizedFullLink();
    };

    /** Runs the legacy release's successor over the piece on Bob's runtime. */
    const update = async (link: NormalizedFullLink) => {
      const member = connect(bob, true);
      const compiled = await compile(member, LEGACY_SECOND_RELEASE);
      const before = member.getCellFromLink(link);
      await before.sync();
      await member.getCellFromLink(getMetaLink(before, "argument")!).sync();
      const tx = member.edit();
      const result = member.getCellFromLink(link, compiled.resultSchema, tx);
      member.run(tx, compiled, undefined, result);
      member.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await member.idle();
      await member.storageManager.synced();
      const reader = connect(alice, false);
      const stored = reader.getCellFromLink(link);
      await stored.sync();
      return stored.getMetaRaw("creator");
    };

    it("records the principal the owned fields name", async () => {
      const link = await createLegacyPiece([]);

      expect(await update(link)).toBe(alice.did());
    });

    it("records the principal the owned fields name, past manifest entries that are not objects", async () => {
      const link = await createLegacyPiece(["not an entry", 7, [1]]);

      expect(await update(link)).toBe(alice.did());
    });
  });
});

/**
 * A field a source update adds with a placeholder `ownerPrincipal` belongs to
 * the piece's recorded creator (`docs/plans/piece-creator-owns-update-added-fields.md`):
 * the label the update persists binds the creator whichever runtime performs
 * it, and the field's writer then admits the creator and refuses anyone else.
 * A piece without a record keeps the first-writer binding.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { getMetaLink } from "../src/link-utils.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const alice = await Identity.fromPassphrase("creator owner binding alice");
const bob = await Identity.fromPassphrase("creator owner binding bob");
const service = await Identity.fromPassphrase("creator owner binding service");
const space: MemorySpace = alice.did();

/** The first release: a count, and nothing about any principal. */
const FIRST_RELEASE = `/// <cts-enable />
import { Default, pattern, Writable } from "commonfabric";
export default pattern<{ count: Writable<Default<number, 0>> }>(
  ({ count }) => ({ count }),
);
`;

/**
 * The second release: the same count, and an argument list the acting
 * principal owns that its one writer, `edit`, adds to.
 */
const SECOND_RELEASE = `/// <cts-enable />
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
const edit = handler<{ add: string }, { items: Writable<string[]> }>(
  (event, { items }) => {
    items.set([...items.get(), event.add]);
  },
);
type Items = RepresentsCurrentUser<
  Cfc<WriteAuthorizedBy<string[], typeof edit>, { ownerPrincipal: CurrentPrincipal }>
>;
export default pattern<{
  count: Writable<Default<number, 0>>;
  items: Writable<Default<Items, []>>;
}>(({ count, items }) => ({ count, items, add: edit({ items }) }));
`;

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

type Result = {
  count?: number;
  notes?: string[];
  items?: string[];
  add?: { add: string };
};

describe("cfc-creator-owner-binding", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let cancels: (() => void)[];
  let client: Runtime;
  let member: Runtime;
  let serving: Runtime;
  let pieces = 0;

  /** A runtime on the shared server, closed when the test ends. */
  const connect = (
    as: Identity,
    options: { servingPosture?: boolean; pieceCreatorRecord?: boolean } = {},
  ): Runtime => {
    const storageManager = EmulatedStorageManager.connectTo(server, { as });
    managers.push(storageManager);
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager,
      ...(options.servingPosture ? { servingPosture: true } : {}),
      experimental: {
        pieceCreatorRecord: options.pieceCreatorRecord ?? true,
      },
    });
    runtimes.push(runtime);
    return runtime;
  };

  const compile = (runtime: Runtime, source: string): Promise<Pattern> =>
    runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    }, { space });

  /** Creates a piece of `source` on `runtime`; returns its result link. */
  const createPiece = async (
    runtime: Runtime,
    source = FIRST_RELEASE,
  ): Promise<NormalizedFullLink> => {
    const compiled = await compile(runtime, source);
    const result = runtime.getCell<Result>(
      space,
      `piece-${pieces++}`,
      compiled.resultSchema,
    );
    const tx = runtime.edit();
    runtime.run(tx, compiled, {}, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    return result.getAsNormalizedFullLink();
  };

  /**
   * Runs the release `source` over the piece at `link` on `runtime`, which
   * installs `items` from its default as a release adding the field does, and
   * keeps the piece running there. Returns the refusal, if any, and the
   * running result cell.
   */
  const update = async (
    runtime: Runtime,
    link: NormalizedFullLink,
    source = SECOND_RELEASE,
  ): Promise<{ refusal: string | undefined; result: Cell<Result> }> => {
    const compiled = await compile(runtime, source);
    const stored = runtime.getCellFromLink<Result>(link);
    await stored.sync();
    await runtime.getCellFromLink(getMetaLink(stored, "argument")!).sync();
    const tx = runtime.edit();
    const result = runtime.getCellFromLink<Result>(
      link,
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, undefined, result);
    runtime.prepareTxForCommit(tx);
    const refusal = (await tx.commit().settled).error?.message;
    const running = runtime.getCellFromLink<Result>(
      link,
      compiled.resultSchema,
    );
    cancels.push(running.sink(() => {}));
    await runtime.idle();
    return { refusal, result: running };
  };

  /** The principals the stored label at `items` of the piece's argument represents. */
  const ownersOfItems = async (
    link: NormalizedFullLink,
  ): Promise<unknown[]> => {
    const reader = connect(alice, { pieceCreatorRecord: false });
    const result = reader.getCellFromLink(link);
    await result.sync();
    const argument = getMetaLink(result, "argument")!;
    await reader.getCellFromLink(argument).sync();
    return (readStoredCfcMetadata(reader.edit(), argument)?.labelMap.entries ??
      [])
      .filter((entry) => entry.path.join("/") === "items")
      .flatMap((entry) => entry.label.integrity ?? [])
      .filter((atom) =>
        isObjectOrArray(atom) && atom.kind === "represents-principal"
      )
      .map((atom) => (atom as { subject: unknown }).subject);
  };

  /**
   * Adds `item` through the writer of the running piece `result` on
   * `runtime`. A refused write lands nothing, which `itemsOf` shows.
   */
  const add = async (
    runtime: Runtime,
    result: Cell<Result>,
    item: string,
  ): Promise<void> => {
    result.key("add").send({ add: item });
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  /** The recorded creator of the piece at `link`, as a runtime opened now reads it. */
  const creatorOf = async (link: NormalizedFullLink): Promise<unknown> => {
    const reader = connect(alice, { pieceCreatorRecord: false });
    const result = reader.getCellFromLink<Result>(link);
    await result.sync();
    return result.getMetaRaw("creator");
  };

  /** The stored `items` of the piece at `link`, as a runtime opened now reads them. */
  const itemsOf = async (link: NormalizedFullLink): Promise<unknown> => {
    const reader = connect(alice, { pieceCreatorRecord: false });
    const result = reader.getCellFromLink<Result>(link);
    await result.sync();
    return await result.key("items").pull();
  };

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    managers = [];
    runtimes = [];
    cancels = [];
    client = connect(alice);
    member = connect(bob);
    serving = connect(service, { servingPosture: true });
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    for (const runtime of runtimes) {
      await runtime.idle();
      await runtime.dispose();
    }
    for (const manager of managers) await manager.close();
    await server.close();
  });

  for (
    const [performer, runtimeOf] of [
      ["the creator's runtime", () => client],
      ["another member's runtime", () => member],
      ["a serving runtime acting for no one", () => serving],
    ] as const
  ) {
    it(`binds the field to the creator when ${performer} installs it`, async () => {
      const link = await createPiece(client);

      expect((await update(runtimeOf(), link)).refusal).toBeUndefined();

      expect(await ownersOfItems(link)).toEqual([alice.did()]);
    });
  }

  it("admits the creator's write through the writer and refuses another member's", async () => {
    const link = await createPiece(client);
    const theirs = await update(member, link);
    expect(theirs.refusal).toBeUndefined();
    const mine = await update(client, link);
    expect(mine.refusal).toBeUndefined();

    await add(member, theirs.result, "forged");
    expect(await itemsOf(link)).toEqual([]);
    await add(client, mine.result, "mine");
    expect(await itemsOf(link)).toEqual(["mine"]);
    expect(await ownersOfItems(link)).toEqual([alice.did()]);
  });

  it("leaves the field to its first writer on a piece with no record", async () => {
    const legacy = connect(alice, { pieceCreatorRecord: false });
    const link = await createPiece(legacy);
    const theirs = await update(member, link);
    expect(theirs.refusal).toBeUndefined();

    expect(await creatorOf(link)).toBeUndefined();
    expect(await ownersOfItems(link)).toEqual([]);
    await add(member, theirs.result, "theirs");
    expect(await itemsOf(link)).toEqual(["theirs"]);
    expect(await ownersOfItems(link)).toEqual([bob.did()]);
  });

  it("records the one principal a piece with no record's owned fields name at its next source transition, and binds the field to them", async () => {
    const legacy = connect(alice, { pieceCreatorRecord: false });
    const link = await createPiece(legacy, LEGACY_RELEASE);
    expect(await creatorOf(link)).toBeUndefined();

    const theirs = await update(member, link, LEGACY_SECOND_RELEASE);
    expect(theirs.refusal).toBeUndefined();

    expect(await creatorOf(link)).toBe(alice.did());
    expect(await ownersOfItems(link)).toEqual([alice.did()]);
    await add(member, theirs.result, "forged");
    expect(await itemsOf(link)).toEqual([]);
  });
});

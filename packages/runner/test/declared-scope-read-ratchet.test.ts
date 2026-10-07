/**
 * What a followed link's declared scope decides for a transaction's read
 * scope. A transaction narrows its read scope at each address it reads. A
 * read that follows a link into a position declared narrower than the link's
 * own scope narrows the same way whether or not an instance at the declared
 * scope exists, because the declaration is what every reader shares: a reader
 * that holds an instance narrows by the address it reads at, and one that
 * does not holds the broad address and sees the declaration's default or
 * whatever the broad instance stores.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { CellScope, JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { CellLinkRefPayload } from "../src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("declared scope read ratchet");
const space = signer.did();

type Holder = { flag: boolean };

/** A holder whose `flag` is declared at `scope`, with a default. */
const holderSchema = (scope: CellScope) =>
  ({
    type: "object",
    properties: {
      flag: { type: "boolean", default: false, scope },
    },
  }) as const satisfies JSONSchema;

describe("declared-scope-read-ratchet", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let seq = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
    seq++;
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** A holder whose `flag` is a space-scoped link to `target`'s root. */
  const holderLinkingTo = (
    target: Cell<unknown>,
    scope: CellScope,
  ): Cell<Holder> => {
    const link = target.getAsNormalizedFullLink();
    const holder = runtime.getCell<Holder>(
      space,
      `holder-${seq}`,
      holderSchema(scope),
      tx,
    );
    holder.setRaw({
      flag: linkRefFrom<CellLinkRefPayload>({
        id: link.id,
        space: link.space,
        scope: "space",
        path: [],
      }),
    } as never);
    return holder;
  };

  it("narrows to the declared scope when the link's target is absent", () => {
    const target = runtime.getCell(space, `absent-${seq}`, undefined, tx);
    const holder = holderLinkingTo(target, "session");

    tx.resetNarrowestReadScope();
    expect(holder.key("flag").get()).toBe(false);
    expect(tx.getNarrowestReadScope()).toBe("session");
  });

  it("narrows to the declared scope when the broad target holds a value", () => {
    const target = runtime.getCell(space, `stored-${seq}`, undefined, tx);
    target.setRaw(true);
    const holder = holderLinkingTo(target, "session");

    tx.resetNarrowestReadScope();
    expect(holder.key("flag").get()).toBe(true);
    expect(tx.getNarrowestReadScope()).toBe("session");
  });

  it("narrows to a declared user scope", () => {
    const target = runtime.getCell(space, `user-${seq}`, undefined, tx);
    const holder = holderLinkingTo(target, "user");

    tx.resetNarrowestReadScope();
    expect(holder.key("flag").get()).toBe(false);
    expect(tx.getNarrowestReadScope()).toBe("user");
  });

  it("keeps the read scope where a position is declared at the link's own scope", () => {
    const target = runtime.getCell(space, `broad-${seq}`, undefined, tx);
    const holder = holderLinkingTo(target, "space");

    tx.resetNarrowestReadScope();
    expect(holder.key("flag").get()).toBe(false);
    expect(tx.getNarrowestReadScope()).toBe("space");
  });

  it("does not widen a read scope already narrower than the declaration", () => {
    const target = runtime.getCell(space, `narrower-${seq}`, undefined, tx);
    const holder = holderLinkingTo(target, "user");

    tx.resetNarrowestReadScope("session");
    expect(holder.key("flag").get()).toBe(false);
    expect(tx.getNarrowestReadScope()).toBe("session");
  });
});

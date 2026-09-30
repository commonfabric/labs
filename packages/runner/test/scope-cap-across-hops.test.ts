/**
 * A schema's scope cap bounds which link scopes a read arriving through it may
 * follow, and one hop does not spend it. A link whose stored schema constrains
 * something replaces the schema a resolution carries, so the cap the reader
 * declared has to travel beside it — otherwise the hop after the replacement
 * follows a link the reader declared it cannot read.
 *
 * The two resolvers reach the chain by different routes: a keyed read walks it
 * in `resolveLink`, a whole-object read in the schema traversal. Both are
 * pinned here, on one chain, so the routes cannot drift apart.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema, SchemaScope } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("scope cap across hops");
const space = signer.did();

const innerSchema = {
  type: "object",
  properties: { field: { type: "string" } },
  required: ["field"],
} as const satisfies JSONSchema;

describe("scope-cap-across-hops", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Build `outer.handle -> middle -> inner`, where `inner` is session-scoped
   * and `middle` holds nothing but a link to it. Reading `outer` through a
   * schema that caps `handle` at `cap` gives the two routes to the value
   * behind that chain.
   *
   * The link stored at `middle` carries `inner`'s schema, which is what makes
   * the chain interesting: that schema constrains, so it replaces the
   * reader's at the first hop — one hop before the session link the cap has
   * to refuse.
   */
  const build = (label: string, cap: SchemaScope) => {
    const inner = runtime.getCell(
      space,
      `hops-inner-${label}`,
      innerSchema,
      tx,
      "session",
    );
    inner.set({ field: "secret" });

    const middle = runtime.getCell(
      space,
      `hops-middle-${label}`,
      innerSchema,
      tx,
    );
    middle.set(inner as never);

    const outer = runtime.getCell(space, `hops-outer-${label}`, undefined, tx);
    outer.set({ handle: middle } as never);

    const capped = outer.asSchema(
      {
        type: "object",
        properties: { handle: { ...innerSchema, scope: cap } },
      } as JSONSchema,
    );
    return {
      // The keyed read, which walks the chain in `resolveLink`.
      keyed: capped.key("handle", "field").get(),
      // The whole-object read, which walks it in the schema traversal.
      whole: capped.get() as { handle?: unknown },
    };
  };

  it("reads `undefined` through a chain whose last link is narrower than the cap", () => {
    const r = build("blocked", "user");
    expect(r.keyed).toBeUndefined();
    expect(r.whole.handle).toBeUndefined();
  });

  it("reads the value through the same chain when the cap admits the last link", () => {
    const r = build("permitted", "session");
    expect(r.keyed).toBe("secret");
    expect(r.whole.handle).toEqual({ field: "secret" });
  });
});

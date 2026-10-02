/**
 * A pattern-owned cell scoped narrower than its result cell starts from its
 * default in every instance, not only in the instance of whoever set the
 * pattern up first.
 */
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const owner = await Identity.fromPassphrase("scoped internal cell seed");
const visitor = await Identity.fromPassphrase(
  "scoped internal cell seed visitor",
);
const space = owner.did();

interface Draft {
  title: string;
  members: string;
}

const EMPTY_DRAFT: Draft = { title: "", members: "" };

const draftSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    members: { type: "string" },
  },
  required: ["title", "members"],
} as const satisfies JSONSchema;

const resultSchema = {
  type: "object",
  properties: {
    draft: { ...draftSchema, asCell: ["cell"] },
  },
  required: ["draft"],
} as const satisfies JSONSchema;

describe("scoped-internal-cell-seed", () => {
  let server: MemoryV2Server.Server;
  let opened: { runtime: Runtime; manager: EmulatedStorageManager }[];

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    opened = [];
  });

  afterEach(async () => {
    for (const { runtime, manager } of opened) {
      await manager.synced();
      await runtime.dispose();
      await manager.close();
    }
    await server.close();
  });

  /**
   * Loads the draft-holding piece in a runtime with a memory session of its
   * own, as a page load does, and returns the piece's draft cell.
   */
  async function load(scope: "user" | "session", as: Identity) {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    opened.push({ runtime, manager });
    const { pattern, Cell } = createTrustedBuilder(runtime).commonfabric;
    const scoped = scope === "user" ? Cell.perUser : Cell.perSession;
    const DraftHolder = pattern(
      () => ({ draft: scoped.of<Draft>(EMPTY_DRAFT) }),
      false,
      resultSchema,
    );
    const resultCell = runtime.getCell(space, "draft holder", resultSchema);
    const result = await runtime.runSynced(resultCell, DraftHolder, {});
    await runtime.idle();
    return { runtime, draft: result.key("draft") };
  }

  /** Writes `title` into the draft's own field, as a bound text input does. */
  async function writeTitle(
    { runtime, draft }: Awaited<ReturnType<typeof load>>,
    title: string,
  ) {
    const tx = runtime.edit();
    draft.withTx(tx).key("title").set(title);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
  }

  for (
    const [scope, later] of [
      ["session", "a later session of the same user"],
      ["user", "another user"],
    ] as const
  ) {
    it(`reads a field written by ${later} beside the ${scope} cell's defaults`, async () => {
      const first = await load(scope, owner);
      await writeTitle(first, "first");
      const second = await load(scope, scope === "user" ? visitor : owner);
      await writeTitle(second, "second");

      expect(second.draft.get()).toEqual({ title: "second", members: "" });
      expect(first.draft.get()).toEqual({ title: "first", members: "" });
    });
  }

  it("keeps a user's per-user value when that user loads again", async () => {
    await writeTitle(await load("user", owner), "kept");
    const reloaded = await load("user", owner);

    expect(reloaded.draft.get()).toEqual({ title: "kept", members: "" });
  });
});

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";

import type { JSONSchema } from "../src/builder/types.ts";
import { initializeScopedArgumentSlots } from "../src/data-updating.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("blocked session continuation");
const space = signer.did();
const schema = {
  type: "object",
  properties: {
    count: {
      type: "number",
      default: 0,
      asCell: [{ kind: "cell", scope: "session" }],
    },
  },
} as const satisfies JSONSchema;

describe("initializeScopedArgumentSlots()", () => {
  let manager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    setServerExecutionConfig(true);
  });

  afterEach(async () => {
    await manager.synced();
    await runtime.dispose();
    await manager.close();
    resetServerExecutionConfig();
  });

  /**
   * Stores an empty record as the space argument and as its user instance,
   * and returns the argument's link with a `space` scope cap recorded at its
   * root.
   */
  async function cappedArgument() {
    const raw = runtime.getCell<Record<string, unknown>>(space, "inputs");
    const user = runtime.getCell<Record<string, unknown>>(
      space,
      "inputs",
      undefined,
      undefined,
      "user",
    );
    await Promise.all([raw.sync(), user.sync()]);
    const seed = runtime.edit();
    raw.withTx(seed).set({});
    user.withTx(seed).set({});
    expect((await seed.commit().settled).error).toBeUndefined();
    const capped: NormalizedFullLink = {
      ...raw.getAsNormalizedFullLink(),
      scopeCaps: [{ depth: 0, scope: "space" }],
    };
    return { raw, user, capped };
  }

  it("links an absent slot to its user continuation where the user instance holds a record", async () => {
    const { raw, user, capped } = await cappedArgument();
    const tx = runtime.edit();
    initializeScopedArgumentSlots(runtime, tx, capped, schema);
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(parseLink(raw.key("count").getRaw({ lastNode: "top" }), raw))
      .toMatchObject({
        id: user.getAsNormalizedFullLink().id,
        path: ["count"],
        scope: "user",
      });
  });

  it("leaves an absent slot absent where reaching its user continuation follows a link the cap blocks", async () => {
    const { raw, user, capped } = await cappedArgument();
    const rebound = runtime.getCell<Record<string, unknown>>(
      space,
      "rebound-inputs",
      undefined,
      undefined,
      "user",
    );
    await rebound.sync();
    const replace = runtime.edit();
    rebound.withTx(replace).set({});
    user.withTx(replace).set(rebound);
    expect((await replace.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    initializeScopedArgumentSlots(runtime, tx, capped, schema);
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(raw.getRaw()).toEqual({});
    expect(rebound.getRaw()).toEqual({});
  });
});

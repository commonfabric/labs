/** Scoped input initialization preserves authored references and existing values. */
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import { initializeScopedArgumentSlots } from "../src/data-updating.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("scoped input initialization");
const space = signer.did();
const argumentSchema = (scope: "user" | "session"): JSONSchema => ({
  type: "object",
  properties: {
    count: { type: "number", default: 0, asCell: [{ kind: "cell", scope }] },
  },
});

describe("scoped-input-initialization", () => {
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
    await runtime.dispose();
    await manager.close();
    resetServerExecutionConfig();
  });

  for (const scope of ["user", "session"] as const) {
    it(`initializes an absent ${scope} input through a whole-object reference`, async () => {
      const raw = runtime.getCell<Record<string, unknown>>(space, "inputs");
      const argument = runtime.getCell(space, "argument");
      await Promise.all([raw.sync(), argument.sync()]);
      const tx = runtime.edit();
      raw.withTx(tx).set({ unrelated: 7 });
      argument.withTx(tx).set(raw);
      initializeScopedArgumentSlots(
        runtime,
        tx,
        argument.getAsNormalizedFullLink(),
        argumentSchema(scope),
      );
      expect((await tx.commit()).error).toBeUndefined();
      const shaped = raw.asSchema(argumentSchema(scope));
      expect(
        shaped.key("count").resolveAsCell().getAsNormalizedFullLink().scope,
      ).toBe(scope);
      expect(raw.key("unrelated").get()).toBe(7);
      const write = runtime.edit();
      raw.withTx(write).key("count").set(3);
      expect((await write.commit()).error).toBeUndefined();
      expect(
        runtime.getCell(space, "inputs", undefined, undefined, scope).key(
          "count",
        ).get(),
      ).toBe(3);
    });
  }

  for (const value of [7, undefined]) {
    it(`preserves an explicitly present ${String(value)} input`, async () => {
      const raw = runtime.getCell<Record<string, unknown>>(space, "present");
      await raw.sync();
      const tx = runtime.edit();
      raw.withTx(tx).set({ count: value });
      initializeScopedArgumentSlots(
        runtime,
        tx,
        raw.getAsNormalizedFullLink(),
        argumentSchema("user"),
      );
      expect(raw.withTx(tx).key("count").getRaw({ lastNode: "top" })).toBe(
        value,
      );
      expect((await tx.commit()).error).toBeUndefined();
    });
  }

  for (const value of [7, undefined, "link"] as const) {
    it(`preserves a present ${String(value)} at an intermediate user slot`, async () => {
      const raw = runtime.getCell<Record<string, unknown>>(
        space,
        "intermediate",
      );
      const user = runtime.getCell<Record<string, unknown>>(
        space,
        "intermediate",
        undefined,
        undefined,
        "user",
      );
      const target = runtime.getCell<number>(space, "explicit-target");
      await Promise.all([raw.sync(), user.sync(), target.sync()]);
      const tx = runtime.edit();
      const input = raw.key("count").getAsNormalizedFullLink();
      raw.withTx(tx).set({
        count: runtime.getCellFromLink({ ...input, scope: "user" }).getAsLink(),
      });
      user.withTx(tx).set({ count: value === "link" ? target : value });
      const before = user.withTx(tx).key("count").getRaw({ lastNode: "top" });
      initializeScopedArgumentSlots(
        runtime,
        tx,
        raw.getAsNormalizedFullLink(),
        argumentSchema("session"),
      );
      expect(user.withTx(tx).key("count").getRaw({ lastNode: "top" })).toEqual(
        before,
      );
      expect((await tx.commit()).error).toBeUndefined();
    });
  }

  for (const overwrite of [undefined, "redirect"] as const) {
    for (const present of [false, true]) {
      it(`preserves a ${overwrite ?? "value"} link to a ${present ? "present" : "missing"} target`, async () => {
        const raw = runtime.getCell<Record<string, unknown>>(space, "linked");
        const target = runtime.getCell<number>(space, "target");
        await Promise.all([raw.sync(), target.sync()]);
        const tx = runtime.edit();
        if (present) target.withTx(tx).set(9);
        const link = overwrite === "redirect"
          ? target.getAsWriteRedirectLink()
          : target.getAsLink();
        raw.withTx(tx).set({ count: link });
        const before = raw.withTx(tx).key("count").getRaw({ lastNode: "top" });
        initializeScopedArgumentSlots(
          runtime,
          tx,
          raw.getAsNormalizedFullLink(),
          argumentSchema("user"),
        );
        const after = raw.withTx(tx).key("count").getRaw({ lastNode: "top" });
        expect(after).toEqual(before);
        expect(parseLink(after, raw)?.scope).toBe("space");
        expect((await tx.commit()).error).toBeUndefined();
      });
    }
  }

  it("preserves an explicit reference to the same slot in user scope", async () => {
    const raw = runtime.getCell<Record<string, unknown>>(space, "self-input");
    const user = runtime.getCell(
      space,
      "self-input",
      undefined,
      undefined,
      "user",
    )
      .key("count");
    await Promise.all([raw.sync(), user.sync()]);
    const tx = runtime.edit();
    raw.withTx(tx).set({ count: user });
    initializeScopedArgumentSlots(
      runtime,
      tx,
      raw.getAsNormalizedFullLink(),
      argumentSchema("session"),
    );
    expect((await tx.commit()).error).toBeUndefined();
    expect(raw.key("count").resolveAsCell().getAsNormalizedFullLink().scope)
      .toBe("user");
  });

  it("preserves a whole-object reference blocked by its follow cap", async () => {
    const raw = runtime.getCell(space, "capped-argument");
    const target = runtime.getCell<Record<string, unknown>>(
      space,
      "capped-target",
      undefined,
      undefined,
      "user",
    );
    await Promise.all([raw.sync(), target.sync()]);
    const seed = runtime.edit();
    target.withTx(seed).set({});
    raw.withTx(seed).set(target);
    expect((await seed.commit()).error).toBeUndefined();
    const authoredLink = raw.getRaw({ lastNode: "top" });

    const blocked = runtime.edit();
    initializeScopedArgumentSlots(
      runtime,
      blocked,
      raw.asSchema({ type: "object", scope: "space" })
        .getAsNormalizedFullLink(),
      argumentSchema("session"),
    );
    expect((await blocked.commit()).error).toBeUndefined();
    expect(raw.getRaw({ lastNode: "top" })).toEqual(authoredLink);
    expect(target.getRaw()).toEqual({});

    const allowed = runtime.edit();
    initializeScopedArgumentSlots(
      runtime,
      allowed,
      raw.asSchema({ type: "object", scope: "user" })
        .getAsNormalizedFullLink(),
      argumentSchema("session"),
    );
    expect((await allowed.commit()).error).toBeUndefined();
    expect(raw.getRaw({ lastNode: "top" })).toEqual(authoredLink);
    expect(parseLink(target.key("count").getRaw({ lastNode: "top" }), target))
      .toMatchObject({
        id: target.getAsNormalizedFullLink().id,
        path: ["count"],
        scope: "session",
      });
  });

  it("rejects initialization that raced with an explicit input write", async () => {
    const raw = runtime.getCell<Record<string, unknown>>(space, "racing");
    await raw.sync();
    const seed = runtime.edit();
    raw.withTx(seed).set({});
    expect((await seed.commit()).error).toBeUndefined();
    const initialize = runtime.edit();
    initializeScopedArgumentSlots(
      runtime,
      initialize,
      raw.getAsNormalizedFullLink(),
      argumentSchema("user"),
    );
    const rebind = runtime.edit();
    raw.withTx(rebind).key("count").set(11);
    expect((await rebind.commit()).error).toBeUndefined();
    expect((await initialize.commit()).error?.name).toBe(
      "StorageTransactionInconsistent",
    );
    expect(raw.key("count").get()).toBe(11);
  });
});

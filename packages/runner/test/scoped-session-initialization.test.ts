import { toFileUrl } from "@std/path";
import * as Engine from "@commonfabric/memory/v2/engine";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import {
  linkRefFrom,
  linkRefPayload,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";

import type { JSONSchema } from "../src/builder/types.ts";
import {
  initializeScopedArgumentSlots,
  scopedArgumentInitializationTargets,
} from "../src/data-updating.ts";
import {
  areLinksSame,
  createSigilLinkFromParsedLink,
  isSigilLink,
  parseLink,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { createRef } from "../src/create-ref.ts";
import { causalFormOfBinding } from "../src/pattern-binding.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("session input continuations");
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

/** Narrows the stored value at a declared link boundary. */
function storedLink(value: unknown) {
  if (!isSigilLink(value)) throw new Error("Expected a stored cell reference");
  return value;
}

describe("scoped-session-initialization", () => {
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
    resetModernCellRepConfig();
  });

  /** Creates an automatic default, then leaves its user instance absent. */
  async function missingContinuation() {
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
    initializeScopedArgumentSlots(
      runtime,
      seed,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    expect((await seed.commit().settled).error).toBeUndefined();
    const clear = runtime.edit();
    user.withTx(clear).set({});
    expect((await clear.commit().settled).error).toBeUndefined();
    return { raw, user };
  }

  it("continues a marked default without changing its reference address", async () => {
    const { raw, user } = await missingContinuation();
    const marked = storedLink(raw.key("count").getRaw({ lastNode: "top" }));
    const explicit = createSigilLinkFromParsedLink(
      user.key("count").getAsNormalizedFullLink(),
    );
    expect(linkRefPayload(marked)).toMatchObject({
      scopeInitialization: "session",
    });
    expect(areLinksSame(marked, explicit, raw.key("count"))).toBe(true);
    const tx = runtime.edit();
    expect(
      scopedArgumentInitializationTargets(
        runtime,
        tx,
        raw.getAsNormalizedFullLink(),
        schema,
      ),
    )
      .toHaveLength(1);
    initializeScopedArgumentSlots(
      runtime,
      tx,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(
      parseLink(user.key("count").getRaw({ lastNode: "top" }), user)?.scope,
    )
      .toBe("session");
    expect(raw.key("count").getRaw({ lastNode: "top" })).toEqual(marked);
    const write = runtime.edit();
    raw.withTx(write).key("count").set(7);
    expect((await write.commit().settled).error).toBeUndefined();
    expect(
      runtime.getCell(space, "inputs", undefined, undefined, "session").key(
        "count",
      ).get(),
    )
      .toBe(7);
  });

  it("preserves an explicit same-address replacement of an automatic link", async () => {
    const { raw, user } = await missingContinuation();
    const replace = runtime.edit();
    raw.withTx(replace).key("count").set(user.key("count"));
    expect((await replace.commit().settled).error).toBeUndefined();
    expect(
      Object.hasOwn(
        linkRefPayload(
          storedLink(raw.key("count").getRaw({ lastNode: "top" })),
        ),
        "scopeInitialization",
      ),
    ).toBe(false);
    const tx = runtime.edit();
    expect(
      scopedArgumentInitializationTargets(
        runtime,
        tx,
        raw.getAsNormalizedFullLink(),
        schema,
      ),
    )
      .toEqual([]);
    initializeScopedArgumentSlots(
      runtime,
      tx,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(user.key("count").getRaw({ lastNode: "top" })).toBeUndefined();
    expect(
      raw.asSchema(schema).key("count").get()!.getAsNormalizedFullLink().scope,
    )
      .toBe("user");
  });

  it("discovers marked user continuations only when server execution is enabled", async () => {
    const { raw, user } = await missingContinuation();
    setServerExecutionConfig(false);
    const local = runtime.edit();
    expect(scopedArgumentInitializationTargets(
      runtime,
      local,
      raw.getAsNormalizedFullLink(),
      schema,
    )).toEqual([]);
    expect((await local.commit().settled).error).toBeUndefined();
    expect(user.getRaw()).toEqual({});

    setServerExecutionConfig(true);
    const served = runtime.edit();
    expect(scopedArgumentInitializationTargets(
      runtime,
      served,
      raw.getAsNormalizedFullLink(),
      schema,
    )).toMatchObject([{
      id: user.getAsNormalizedFullLink().id,
      space,
      path: ["count"],
      scope: "user",
    }]);
    expect((await served.commit().settled).error).toBeUndefined();
  });

  for (const value of [7, undefined, []]) {
    it(`preserves a non-record argument containing ${JSON.stringify(value)}`, async () => {
      const raw = runtime.getCell<unknown>(space, "non-record-inputs");
      await raw.sync();
      const seed = runtime.edit();
      raw.withTx(seed).set(value);
      expect((await seed.commit().settled).error).toBeUndefined();
      const tx = runtime.edit();
      expect(scopedArgumentInitializationTargets(
        runtime,
        tx,
        raw.getAsNormalizedFullLink(),
        schema,
      )).toEqual([]);
      initializeScopedArgumentSlots(
        runtime,
        tx,
        raw.getAsNormalizedFullLink(),
        schema,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(raw.getRaw()).toEqual(value);
    });
  }

  it("keeps an inline space value outside continuation discovery", async () => {
    const raw = runtime.getCell<Record<string, unknown>>(
      space,
      "inline-inputs",
    );
    const user = runtime.getCell<Record<string, unknown>>(
      space,
      "inline-inputs",
      undefined,
      undefined,
      "user",
    );
    await Promise.all([raw.sync(), user.sync()]);
    const replace = runtime.edit();
    raw.withTx(replace).set({ count: 7 });
    user.withTx(replace).set({});
    expect((await replace.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    expect(scopedArgumentInitializationTargets(
      runtime,
      tx,
      raw.getAsNormalizedFullLink(),
      schema,
    )).toEqual([]);
    initializeScopedArgumentSlots(
      runtime,
      tx,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(raw.getRaw()).toEqual({ count: 7 });
    expect(user.getRaw()).toEqual({});
  });

  it("does not discover continuations through a blocked whole-object reference", async () => {
    const { raw, user } = await missingContinuation();
    const replace = runtime.edit();
    raw.withTx(replace).set(user);
    expect((await replace.commit().settled).error).toBeUndefined();
    const reference = raw.getRaw({ lastNode: "top" });
    const tx = runtime.edit();
    const cappedArgument = raw.asSchema({ type: "object", scope: "space" })
      .getAsNormalizedFullLink();
    expect(scopedArgumentInitializationTargets(
      runtime,
      tx,
      cappedArgument,
      schema,
    )).toEqual([]);
    initializeScopedArgumentSlots(runtime, tx, cappedArgument, schema);
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(raw.getRaw({ lastNode: "top" })).toEqual(reference);
    expect(user.getRaw()).toEqual({});

    const allowed = runtime.edit();
    initializeScopedArgumentSlots(
      runtime,
      allowed,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    expect((await allowed.commit().settled).error).toBeUndefined();
    expect(raw.getRaw({ lastNode: "top" })).toEqual(reference);
    expect(parseLink(user.key("count").getRaw({ lastNode: "top" }), user))
      .toMatchObject({
        id: user.getAsNormalizedFullLink().id,
        path: ["count"],
        scope: "session",
      });
  });

  it("preserves a user container rebound to an explicit reference", async () => {
    const { raw, user } = await missingContinuation();
    const target = runtime.getCell<Record<string, unknown>>(
      space,
      "rebound-inputs",
      undefined,
      undefined,
      "user",
    );
    await target.sync();
    const replace = runtime.edit();
    target.withTx(replace).set({});
    user.withTx(replace).set(target);
    expect((await replace.commit().settled).error).toBeUndefined();
    const reference = user.getRaw({ lastNode: "top" });
    const tx = runtime.edit();
    initializeScopedArgumentSlots(
      runtime,
      tx,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(user.getRaw({ lastNode: "top" })).toEqual(reference);
    expect(target.getRaw()).toEqual({});
    const handle = raw.asSchema(schema).key("count").get()!;
    expect(handle.getAsNormalizedFullLink().scope).toBe("user");
    const write = runtime.edit();
    handle.withTx(write).set(9);
    expect((await write.commit().settled).error).toBeUndefined();
    expect(target.key("count").get()).toBe(9);
  });

  it("reestablishes a declaration through an explicit write using the session schema", async () => {
    const { raw, user } = await missingContinuation();
    const replace = runtime.edit();
    raw.withTx(replace).key("count").set(user.key("count"));
    expect((await replace.commit().settled).error).toBeUndefined();
    const write = runtime.edit();
    raw.asSchema(schema).withTx(write).key("count").set(5);
    expect((await write.commit().settled).error).toBeUndefined();
    expect(
      linkRefPayload(storedLink(raw.key("count").getRaw({ lastNode: "top" }))),
    )
      .toMatchObject({ scopeInitialization: "session" });
    expect(raw.key("count").resolveAsCell().getAsNormalizedFullLink().scope)
      .toBe("session");
    expect(raw.key("count").get()).toBe(5);
  });

  it("keeps the initialization declaration when reassigning its raw marked link", async () => {
    const { raw, user } = await missingContinuation();
    const marked = storedLink(raw.key("count").getRaw({ lastNode: "top" }));
    const tx = runtime.edit();
    raw.withTx(tx).key("count").set(marked);
    initializeScopedArgumentSlots(
      runtime,
      tx,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(
      linkRefPayload(storedLink(raw.key("count").getRaw({ lastNode: "top" }))),
    ).toMatchObject({ scopeInitialization: "session" });
    expect(
      parseLink(user.key("count").getRaw({ lastNode: "top" }), user)?.scope,
    ).toBe("session");
  });

  it("preserves a marked reference to another document without initializing its target", async () => {
    const { raw } = await missingContinuation();
    const foreign = runtime.getCell(
      space,
      "foreign-inputs",
      undefined,
      undefined,
      "user",
    );
    await foreign.sync();
    const marked = linkRefFrom({
      ...linkRefPayload(createSigilLinkFromParsedLink(
        foreign.key("count").getAsNormalizedFullLink(),
      )),
      scopeInitialization: "session",
    });
    const tx = runtime.edit();
    raw.withTx(tx).key("count").set(marked);
    expect(scopedArgumentInitializationTargets(
      runtime,
      tx,
      raw.getAsNormalizedFullLink(),
      schema,
    )).toEqual([]);
    initializeScopedArgumentSlots(
      runtime,
      tx,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(raw.key("count").getRaw({ lastNode: "top" })).toEqual(marked);
    expect(foreign.key("count").getRaw({ lastNode: "top" })).toBeUndefined();
  });

  it("continues a copied raw relative declaration at its new slot", async () => {
    const { raw, user } = await missingContinuation();
    const copy = runtime.getCell<Record<string, unknown>>(
      space,
      "copied-inputs",
    );
    const copyUser = runtime.getCell(
      space,
      "copied-inputs",
      undefined,
      undefined,
      "user",
    );
    await Promise.all([copy.sync(), copyUser.sync()]);
    const tx = runtime.edit();
    copy.withTx(tx).set({
      count: raw.key("count").getRaw({ lastNode: "top" }),
    });
    initializeScopedArgumentSlots(
      runtime,
      tx,
      copy.getAsNormalizedFullLink(),
      schema,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(copy.key("count").resolveAsCell().getAsNormalizedFullLink())
      .toMatchObject({
        id: copy.getAsNormalizedFullLink().id,
        path: ["count"],
        scope: "session",
      });
    expect(user.key("count").getRaw({ lastNode: "top" })).toBeUndefined();
  });

  for (const declared of [false, true]) {
    for (const value of [7, undefined, "reference"] as const) {
      it(`preserves an existing ${String(value)} user slot with a ${declared ? "marked" : "missing"} space declaration`, async () => {
        const { raw, user } = await missingContinuation();
        const reference = runtime.getCell(space, "explicit-target");
        await reference.sync();
        const seed = runtime.edit();
        if (!declared) raw.withTx(seed).set({});
        user.withTx(seed).set({
          count: value === "reference" ? reference : value,
        });
        expect((await seed.commit().settled).error).toBeUndefined();
        const before = user.key("count").getRaw({ lastNode: "top" });
        const tx = runtime.edit();
        initializeScopedArgumentSlots(
          runtime,
          tx,
          raw.getAsNormalizedFullLink(),
          schema,
        );
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(user.key("count").getRaw({ lastNode: "top" })).toEqual(before);
        expect(Object.hasOwn(user.getRaw()!, "count")).toBe(true);
        expect(
          parseLink(raw.key("count").getRaw({ lastNode: "top" }), raw)?.scope,
        ).toBe("user");
        const write = runtime.edit();
        if (value === "reference") {
          reference.withTx(write).set(9);
        } else {
          raw.asSchema(schema).withTx(write).key("count").get()!.set(9);
        }
        expect((await write.commit().settled).error).toBeUndefined();
        if (value === "reference") {
          expect(raw.key("count").get()).toBe(9);
          expect(user.key("count").getRaw({ lastNode: "top" })).toEqual(before);
        } else {
          expect(user.key("count").get()).toBe(9);
        }
        expect(
          runtime.getCell(space, "inputs", undefined, undefined, "session")
            .key("count").getRaw({ lastNode: "top" }),
        ).toBeUndefined();
      });
    }

    it(`preserves an explicitly undefined user container with a ${declared ? "marked" : "missing"} space declaration`, async () => {
      const { raw, user } = await missingContinuation();
      const replace = runtime.edit();
      if (!declared) raw.withTx(replace).set({});
      user.asSchema<unknown>(undefined).withTx(replace).set(undefined);
      expect((await replace.commit().settled).error).toBeUndefined();
      const tx = runtime.edit();
      initializeScopedArgumentSlots(
        runtime,
        tx,
        raw.getAsNormalizedFullLink(),
        schema,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(user.getRaw()).toBeUndefined();
    });
  }

  for (const modern of [false, true]) {
    it(`preserves the declaration through the ${modern ? "modern" : "legacy"} wire representation without changing cause identity`, async () => {
      setModernCellRepConfig(modern);
      const { raw, user } = await missingContinuation();
      const marked = storedLink(raw.key("count").getRaw({ lastNode: "top" }));
      const explicit = createSigilLinkFromParsedLink(
        parseLink(marked, raw.key("count")),
        { base: raw.key("count").getAsNormalizedFullLink() },
      );
      const roundTripped = storedLink(
        fabricFromJsonValue(jsonFromFabricValue(marked)),
      );
      expect(linkRefPayload(roundTripped)).toMatchObject({
        scopeInitialization: "session",
      });
      expect(createRef({}, causalFormOfBinding({ count: marked })).hashString)
        .toBe(
          createRef({}, causalFormOfBinding({ count: explicit })).hashString,
        );
      const tx = runtime.edit();
      raw.withTx(tx).key("count").set(roundTripped);
      initializeScopedArgumentSlots(
        runtime,
        tx,
        raw.getAsNormalizedFullLink(),
        schema,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(
        parseLink(user.key("count").getRaw({ lastNode: "top" }), user)?.scope,
      ).toBe("session");
    });
  }

  it("preserves the declaration while filtering forged link integrity", async () => {
    const { raw } = await missingContinuation();
    const marked = storedLink(raw.key("count").getRaw({ lastNode: "top" }));
    const tx = runtime.edit();
    raw.withTx(tx).key("count").set(linkRefFrom({
      ...linkRefPayload(marked),
      cfcLabelView: {
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: ["session-declaration"],
            integrity: [{
              type: "https://commonfabric.org/cfc/atom/InjectionSafe",
            }],
          },
        }],
      },
    }));
    tx.prepareCfc();
    expect((await tx.commit().settled).error).toBeUndefined();
    const persisted = linkRefPayload(
      storedLink(raw.key("count").getRaw({ lastNode: "top" })),
    );
    expect(persisted).toMatchObject({ scopeInitialization: "session" });
    expect(Object.hasOwn(persisted, "cfcLabelView")).toBe(false);
    const inspect = runtime.edit();
    const metadata = readStoredCfcMetadata(
      inspect,
      raw.getAsNormalizedFullLink(),
    );
    inspect.abort();
    expect(
      metadata?.labelMap.entries.map((entry) => entry.label.confidentiality),
    )
      .toContainEqual(["session-declaration"]);
    expect(
      metadata!.labelMap.entries.flatMap((entry) => entry.label.integrity ?? [])
        .some((atom) =>
          isObjectOrArray(atom) &&
          "type" in atom &&
          atom.type === "https://commonfabric.org/cfc/atom/InjectionSafe"
        ),
    )
      .toBe(false);
  });

  it("rejects a stale declaration at the engine after an explicit reference replacement", async () => {
    const { raw, user } = await missingContinuation();
    const marked = storedLink(raw.key("count").getRaw({ lastNode: "top" }));
    const explicit = createSigilLinkFromParsedLink(
      user.key("count").getAsNormalizedFullLink(),
    );
    const holder = runtime.edit();
    initializeScopedArgumentSlots(
      runtime,
      holder,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    const reads = (manager.open(space).replica as SpaceReplica)
      .accessForTestingOnly.buildReads(holder.tx, 1);
    const id = raw.getAsNormalizedFullLink().id;
    holder.abort();

    // Replay the captured wire dependencies independently of local snapshot
    // validation. A same-key replacement preserves the parent's key set.
    for (const replacement of [false, true]) {
      const file = await Deno.makeTempFile({ suffix: ".sqlite" });
      const engine = await Engine.open({ url: toFileUrl(file) });
      try {
        Engine.applyCommit(engine, {
          sessionId: "writer",
          principal: signer.did(),
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id,
              scope: "space",
              value: { value: { count: marked } },
            }],
          },
        });
        Engine.applyCommit(engine, {
          sessionId: "writer",
          principal: signer.did(),
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id,
              scope: "user",
              value: { value: {} },
            }],
          },
        });
        if (replacement) {
          Engine.applyCommit(engine, {
            sessionId: "writer",
            principal: signer.did(),
            commit: {
              localSeq: 3,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "patch",
                id,
                scope: "space",
                patches: [{
                  op: "replace",
                  path: "/value/count",
                  value: explicit,
                }],
              }],
            },
          });
        }
        const commit = () =>
          Engine.applyCommit(engine, {
            sessionId: "initializer",
            principal: signer.did(),
            commit: {
              localSeq: 1,
              reads,
              operations: [{
                op: "patch",
                id,
                scope: "user",
                patches: [{
                  op: "add",
                  path: "/value/count",
                  value: createSigilLinkFromParsedLink({
                    ...user.key("count").getAsNormalizedFullLink(),
                    scope: "session",
                  }),
                }],
              }],
            },
          });
        if (replacement) expect(commit).toThrow(Engine.ConflictError);
        else expect(commit).not.toThrow();
      } finally {
        Engine.close(engine);
        await Deno.remove(file);
      }
    }
  });

  it("rejects initialization that races an explicit same-address replacement", async () => {
    const { raw, user } = await missingContinuation();
    const initialize = runtime.edit();
    initializeScopedArgumentSlots(
      runtime,
      initialize,
      raw.getAsNormalizedFullLink(),
      schema,
    );
    const replace = runtime.edit();
    raw.withTx(replace).key("count").set(user.key("count"));
    expect((await replace.commit().settled).error).toBeUndefined();
    expect((await initialize.commit().settled).error?.name).toBe(
      "StorageTransactionInconsistent",
    );
    expect(user.key("count").getRaw({ lastNode: "top" })).toBeUndefined();
  });
});

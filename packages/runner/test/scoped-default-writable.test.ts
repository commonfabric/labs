import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";

import type { CellScope, JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("scoped default writable");
const space = signer.did();

const countSchema = (scope: CellScope) =>
  ({
    type: "object",
    properties: {
      count: {
        type: "number",
        default: 0,
        asCell: [{ kind: "cell", scope }],
      },
    },
  }) as const satisfies JSONSchema;

describe("scoped-default-writable", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await storageManager.synced();
    await runtime.dispose();
    await storageManager.close();
  });

  for (const scope of ["user", "session"] as const) {
    it(`reads and writes an absent default through its declared ${scope} instance`, async () => {
      const raw = runtime.getCell<Record<string, unknown>>(
        space,
        `default-${scope}`,
      );
      const seed = runtime.edit();
      raw.withTx(seed).set({});
      expect((await seed.commit()).error).toBeUndefined();

      const shaped = raw.asSchema(countSchema(scope));
      const whole = shaped.get().count!;
      const projected = shaped.key("count").get()!;
      const address = {
        id: raw.getAsNormalizedFullLink().id,
        path: ["count"],
        space,
        scope,
      };
      expect(whole.getAsNormalizedFullLink()).toMatchObject(address);
      expect(projected.getAsNormalizedFullLink()).toMatchObject(address);
      expect(whole.get()).toBe(0);
      expect(projected.get()).toBe(0);

      const write = runtime.edit();
      projected.withTx(write).set(7);
      expect((await write.commit()).error).toBeUndefined();
      expect(runtime.getCellFromLink(address).get()).toBe(7);
      expect(shaped.key("count").get()!.get()).toBe(7);
      expect(raw.key("count").getRaw()).toBeUndefined();
    });

    it(`preserves an inline space value under a ${scope} handle declaration`, async () => {
      const raw = runtime.getCell<Record<string, unknown>>(
        space,
        `inline-${scope}`,
      );
      const seed = runtime.edit();
      raw.withTx(seed).set({ count: 4 });
      expect((await seed.commit()).error).toBeUndefined();

      const shaped = raw.asSchema(countSchema(scope));
      const projected = shaped.key("count").get()!;
      expect(shaped.get().count!.getAsNormalizedFullLink().scope).toBe("space");
      expect(projected.getAsNormalizedFullLink()).toMatchObject({
        id: raw.getAsNormalizedFullLink().id,
        path: ["count"],
        scope: "space",
      });
      expect(projected.get()).toBe(4);
      const write = runtime.edit();
      projected.withTx(write).set(8);
      expect((await write.commit()).error).toBeUndefined();
      expect(raw.key("count").get()).toBe(8);
      expect(
        runtime.getCellFromLink({
          ...projected.getAsNormalizedFullLink(),
          schema: undefined,
          scope,
        }).getRaw(),
      ).toBeUndefined();
    });

    it(`preserves an explicitly undefined space slot under a ${scope} declaration`, async () => {
      const raw = runtime.getCell<Record<string, unknown>>(
        space,
        `undefined-${scope}`,
      );
      const seed = runtime.edit();
      raw.withTx(seed).set({ count: undefined });
      expect((await seed.commit()).error).toBeUndefined();
      expect(Object.hasOwn(raw.get(), "count")).toBe(true);

      const shaped = raw.asSchema(countSchema(scope));
      const projected = shaped.key("count").get()!;
      expect(shaped.get().count!.getAsNormalizedFullLink().scope).toBe("space");
      expect(projected.getAsNormalizedFullLink().scope).toBe("space");
      expect(projected.get()).toBe(0);
      const write = runtime.edit();
      projected.withTx(write).set(8);
      expect((await write.commit()).error).toBeUndefined();
      expect(raw.key("count").get()).toBe(8);
      expect(
        runtime.getCell(
          space,
          `undefined-${scope}`,
          undefined,
          undefined,
          scope,
        )
          .key("count").getRaw(),
      ).toBeUndefined();
    });

    it(`rejects a ${scope} default write when a concurrent writer fills the space slot`, async () => {
      const raw = runtime.getCell<Record<string, unknown>>(
        space,
        `inferred-target-${scope}`,
      );
      const seed = runtime.edit();
      raw.withTx(seed).set({});
      expect((await seed.commit()).error).toBeUndefined();
      const holder = runtime.edit();
      const projected = raw.withTx(holder).asSchema(countSchema(scope))
        .key("count").get()!;
      expect(projected.getAsNormalizedFullLink().scope).toBe(scope);
      projected.set(7);
      const replica = storageManager.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(holder.tx, 1);
      const id = raw.getAsNormalizedFullLink().id;
      holder.abort();

      // Validate the captured wire reads at the engine, independently of the
      // originating replica's local snapshot-conflict check.
      for (const fill of [false, true]) {
        const path = await Deno.makeTempFile({ suffix: ".sqlite" });
        const engine = await Engine.open({ url: toFileUrl(path) });
        try {
          Engine.applyCommit(engine, {
            sessionId: "writer",
            principal: signer.did(),
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{ op: "set", id, value: { value: {} } }],
            },
          });
          if (fill) {
            Engine.applyCommit(engine, {
              sessionId: "writer",
              principal: signer.did(),
              commit: {
                localSeq: 2,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "patch",
                  id,
                  patches: [{ op: "add", path: "/value/count", value: 3 }],
                }],
              },
            });
          }
          const commit = () =>
            Engine.applyCommit(engine, {
              sessionId: "holder",
              principal: signer.did(),
              commit: {
                localSeq: 1,
                reads,
                operations: [{
                  op: "set",
                  id,
                  scope,
                  value: { value: { count: 7 } },
                }],
              },
            });
          if (fill) expect(commit).toThrow(Engine.ConflictError);
          else expect(commit).not.toThrow();
        } finally {
          Engine.close(engine);
          await Deno.remove(path);
        }
      }
    });

    for (const overwrite of ["this", "redirect"] as const) {
      it(`preserves a ${overwrite} link to an absent space referent under a ${scope} declaration`, async () => {
        const raw = runtime.getCell<Record<string, unknown>>(
          space,
          `linked-${scope}-${overwrite}`,
        );
        const target = runtime.getCell<number>(
          space,
          `absent-target-${scope}-${overwrite}`,
        );
        const seed = runtime.edit();
        raw.withTx(seed).set({
          count: overwrite === "redirect"
            ? target.getAsWriteRedirectLink()
            : target.getAsLink(),
        });
        expect((await seed.commit()).error).toBeUndefined();

        const projected = raw.asSchema(countSchema(scope)).key("count").get()!;
        expect(projected.getAsNormalizedFullLink()).toMatchObject({
          id: target.getAsNormalizedFullLink().id,
          path: [],
          scope: "space",
        });
        const write = runtime.edit();
        projected.withTx(write).set(9);
        expect((await write.commit()).error).toBeUndefined();
        expect(target.get()).toBe(9);
        expect(parseLink(raw.key("count").getRaw(), raw.key("count")))
          .toMatchObject({
            id: target.getAsNormalizedFullLink().id,
            scope: "space",
          });
        expect(
          runtime.getCellFromLink({
            ...target.getAsNormalizedFullLink(),
            scope,
          }).getRaw(),
        ).toBeUndefined();
      });
    }

    it(`creates a ${scope} default at an absent slot reached through an ancestor link`, async () => {
      const target = runtime.getCell<Record<string, unknown>>(
        space,
        `ancestor-target-${scope}`,
      );
      const raw = runtime.getCell<Record<string, unknown>>(
        space,
        `ancestor-${scope}`,
      );
      const seed = runtime.edit();
      target.withTx(seed).set({});
      raw.withTx(seed).set(target);
      expect((await seed.commit()).error).toBeUndefined();

      const projected = raw.asSchema(countSchema(scope)).key("count").get()!;
      expect(projected.getAsNormalizedFullLink()).toMatchObject({
        id: target.getAsNormalizedFullLink().id,
        path: ["count"],
        scope,
      });
      const write = runtime.edit();
      projected.withTx(write).set(6);
      expect((await write.commit()).error).toBeUndefined();
      expect(
        runtime.getCellFromLink({
          ...target.getAsNormalizedFullLink(),
          path: ["count"],
          scope,
        }).get(),
      ).toBe(6);
      expect(target.key("count").getRaw()).toBeUndefined();
    });
  }

  for (const compound of [false, true]) {
    it(`keeps ${compound ? "compound" : "direct"} materialized mutations on their selected instance`, async () => {
      const raw = runtime.getCell<{ count: number; values: number[] }>(
        space,
        "materialized-mutations",
      );
      const seed = runtime.edit();
      raw.withTx(seed).set({ count: 1, values: [2] });
      expect((await seed.commit()).error).toBeUndefined();
      const projection = {
        type: "object",
        properties: {
          count: { type: "number" },
          values: { type: "array", items: { type: "number" } },
        },
        asCell: [{ kind: "cell", scope: "user" }],
      } as const;
      const held = raw.asSchema<Cell<{ count: number; values: number[] }>>(
        compound
          ? {
            ...projection,
            properties: undefined,
            allOf: [
              { type: "object", properties: { count: { type: "number" } } },
              {
                type: "object",
                properties: {
                  values: { type: "array", items: { type: "number" } },
                },
              },
            ],
          }
          : projection,
      ).get();
      expect(held.getAsNormalizedFullLink().scope).toBe("space");
      const write = runtime.edit();
      held.withTx(write).key("count").set(3);
      held.withTx(write).key("values").push(4);
      held.withTx(write).key("values").addUnique(5);
      expect((await write.commit()).error).toBeUndefined();
      expect(raw.get()).toEqual({ count: 3, values: [2, 4, 5] });
      expect(
        runtime.getCell(
          space,
          "materialized-mutations",
          undefined,
          undefined,
          "user",
        ).getRaw(),
      ).toBeUndefined();
      const replace = runtime.edit();
      held.withTx(replace).set({ count: 6, values: [7] });
      expect((await replace.commit()).error).toBeUndefined();
      expect(raw.get()).toEqual({ count: 6, values: [7] });
      expect(
        runtime.getCell(
          space,
          "materialized-mutations",
          undefined,
          undefined,
          "user",
        ).getRaw(),
      ).toBeUndefined();
    });
  }

  it("preserves an unresolved ancestor target until its document arrives", async () => {
    const target = runtime.getCell<Record<string, unknown>>(space, "pending");
    const raw = runtime.getCell<Record<string, unknown>>(space, "pending-link");
    const seed = runtime.edit();
    raw.withTx(seed).set(target);
    expect((await seed.commit()).error).toBeUndefined();

    const projected = raw.asSchema(countSchema("user")).key("count").get()!;
    expect(projected.getAsNormalizedFullLink()).toMatchObject({
      id: target.getAsNormalizedFullLink().id,
      scope: "space",
      pendingHopDoc: true,
    });
  });

  it("keeps a blocked ancestor unavailable under the declared follow cap", async () => {
    const target = runtime.getCellFromLink<Record<string, unknown>>({
      ...runtime.getCell(space, "blocked-target").getAsNormalizedFullLink(),
      scope: "session",
    });
    const raw = runtime.getCell<Record<string, unknown>>(space, "blocked-link");
    const seed = runtime.edit();
    target.withTx(seed).set({});
    raw.withTx(seed).set(target);
    expect((await seed.commit()).error).toBeUndefined();

    const projected = raw.asSchema(countSchema("user")).key("count").get()!;
    expect(projected.getAsNormalizedFullLink().id.startsWith("data:")).toBe(
      true,
    );
    expect(projected.getAsNormalizedFullLink().scope).toBe("space");
    expect(target.key("count").getRaw()).toBeUndefined();
  });

  it("reprojects a default handle when a space value arrives at its slot", async () => {
    const raw = runtime.getCell<Record<string, unknown>>(space, "arriving");
    const seed = runtime.edit();
    raw.withTx(seed).set({});
    expect((await seed.commit()).error).toBeUndefined();

    const scopes: CellScope[] = [];
    const cancel = raw.asSchema(countSchema("user")).key("count").sink(
      (handle) => {
        scopes.push(handle!.getAsNormalizedFullLink().scope);
      },
    );
    try {
      await runtime.idle();
      expect(scopes.at(-1)).toBe("user");
      const write = runtime.edit();
      raw.withTx(write).key("count").set(3);
      expect((await write.commit()).error).toBeUndefined();
      await runtime.idle();
      expect(scopes.at(-1)).toBe("space");
    } finally {
      cancel();
    }
  });

  for (const readThrough of [false, true]) {
    it(`${readThrough ? "records" : "excludes"} a value dependency after ${readThrough ? "reading through" : "only projecting"} a handle`, async () => {
      const raw = runtime.getCell<Record<string, unknown>>(space, "concurrent");
      const seed = runtime.edit();
      raw.withTx(seed).set({ count: 4 });
      expect((await seed.commit()).error).toBeUndefined();

      const holder = runtime.edit();
      const projected: Cell<number> = raw.withTx(holder)
        .asSchema(countSchema("user")).key("count").get()!;
      expect(projected.getAsNormalizedFullLink().scope).toBe("space");
      if (readThrough) expect(projected.get()).toBe(4);
      const replica = storageManager.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(holder.tx, 1)
        .confirmed;
      expect(
        reads.some((read) =>
          read.id === raw.getAsNormalizedFullLink().id &&
          read.path.join("/") === "value/count"
        ),
      ).toBe(readThrough);
      holder.abort();
    });
  }
});

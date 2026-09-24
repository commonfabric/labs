/**
 * An `asCell` entry's `scope` is a follow cap: it bounds which link scopes a
 * read arriving through that schema may follow (ContextualFlowControl
 * .getSchemaScopeCap). It is what lets a space-scoped list require that every
 * handle in it points somewhere every reader in the space can resolve.
 *
 * The cap has to mean the same thing however the handle is reached. These tests
 * pin the three routes to one answer:
 *
 *   1. the value projection            -- cell.key("handle").get()
 *   2. a key() chain past the handle   -- cell.key("handle", "field").get()
 *   3. an explicit dereference         -- cell.key("handle").resolveAsCell()
 *
 * Before #5230 only (3) consulted the cap: (1) never checked it, and (2) lost
 * it because key() narrows through getSchemaAtPath, which drops the ancestor's
 * asCell entry, leaving resolveLink's schemaScopeForLink() with nothing to
 * check one hop later.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { externalizeSchema } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema, SchemaScope } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("ascell scope cap");
const space = signer.did();

const innerSchema = {
  type: "object",
  properties: { field: { type: "string" } },
  required: ["field"],
} as const satisfies JSONSchema;

describe("asCell scope cap", () => {
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
   * Build `{ handle: <link to a cell in `targetScope`> }` where `handle`'s
   * asCell entry declares `cap`, and return the three routes to the handle.
   */
  const build = (
    label: string,
    cap: SchemaScope | undefined,
    targetScope: "space" | "user" | "session",
  ) => {
    const inner = runtime.getCell(
      space,
      `cap-inner-${label}`,
      innerSchema,
      tx,
      targetScope,
    );
    inner.set({ field: "secret" });

    const outer = runtime.getCell(
      space,
      `cap-outer-${label}`,
      {
        type: "object",
        properties: {
          handle: {
            ...innerSchema,
            asCell: cap === undefined
              ? ["cell"]
              : [{ kind: "cell", scope: cap }],
          },
        },
        required: ["handle"],
      } as JSONSchema,
      tx,
    );
    outer.set({ handle: inner } as never);

    const projected = outer.key("handle").get();
    return {
      outer,
      // 1. value projection: the Cell the asCell slot materializes to
      projection: isCell(projected)
        ? (projected as { get(): unknown }).get()
        : projected,
      // 2. key() chain continuing past the handle
      through: outer.key("handle", "field").get(),
      // 3. explicit dereference
      dereferenced: outer.key("handle").resolveAsCell().key("field").get(),
      // 4. the handle reached as a PROPERTY of a whole-object read. This goes
      //    through SchemaObjectTraverser rather than validateAndTransform's
      //    top-level asCell path, and builds the handle in getNextCellLink.
      whole: (() => {
        const parent = (outer.get() ?? {}) as { handle?: unknown };
        const handle = parent.handle;
        return isCell(handle) ? (handle as { get(): unknown }).get() : handle;
      })(),
    };
  };

  it("blocks every route when the cap is narrower than the link", () => {
    // handle caps follows at `space`; the stored link is session-scoped.
    const r = build("blocked", "space", "session");
    expect(r.dereferenced).toBeUndefined();
    expect(r.through).toBeUndefined();
    expect(r.projection).toBeUndefined();
    expect(r.whole).toBeUndefined();
  });

  it("allows every route when the cap admits the link's scope", () => {
    // A session cap is permissive: it admits space, user and session links.
    const r = build("permitted", "session", "session");
    expect(r.dereferenced).toBe("secret");
    expect(r.through).toBe("secret");
    expect(r.projection).toEqual({ field: "secret" });
    expect(r.whole).toEqual({ field: "secret" });
  });

  it("allows every route when no cap is declared", () => {
    const r = build("uncapped", undefined, "session");
    expect(r.dereferenced).toBe("secret");
    expect(r.through).toBe("secret");
    expect(r.projection).toEqual({ field: "secret" });
    expect(r.whole).toEqual({ field: "secret" });
  });

  it("allows every route when the link is no narrower than the cap", () => {
    const r = build("same-scope", "space", "space");
    expect(r.dereferenced).toBe("secret");
    expect(r.through).toBe("secret");
    expect(r.projection).toEqual({ field: "secret" });
    expect(r.whole).toEqual({ field: "secret" });
  });

  it("keeps the cap reachable after key() narrows past the handle", () => {
    const inner = runtime.getCell(
      space,
      "cap-schema-inner",
      innerSchema,
      tx,
      "session",
    );
    inner.set({ field: "secret" });
    const outer = runtime.getCell(
      space,
      "cap-schema-outer",
      {
        type: "object",
        properties: {
          handle: {
            ...innerSchema,
            asCell: [{ kind: "cell", scope: "space" }],
          },
        },
        required: ["handle"],
      } as JSONSchema,
      tx,
    );
    outer.set({ handle: inner } as never);

    // The cap is visible on the handle itself...
    expect(
      ContextualFlowControl.getSchemaScopeCap(outer.key("handle").schema),
    ).toBe("space");
    // ...and the leaf schema below it legitimately carries no cap of its own,
    // so the link has to remember the one declared at depth 1.
    expect(
      ContextualFlowControl.getSchemaScopeCap(
        outer.key("handle", "field").schema,
      ),
    ).toBeUndefined();
    expect(
      outer.key("handle", "field").getAsNormalizedFullLink().scopeCaps,
    ).toEqual([{ depth: 1, scope: "space" }]);
  });

  it("records the cap declared at the address key() starts from", () => {
    // The chained form must reach the same answer as the varargs form. This
    // one does NOT depend on the seed -- `outer.key("handle")` already
    // recorded depth 1 in its own loop, and the chained call inherits it. The
    // seed is what the next test covers.
    const r = build("chained", "space", "session");
    const handle = r.outer.key("handle");
    expect(handle.key("field").getAsNormalizedFullLink().scopeCaps)
      .toEqual([{ depth: 1, scope: "space" }]);
    expect(handle.key("field").get()).toBeUndefined();
  });

  it("records a cap declared at the root of a link key() never walked", () => {
    // A cell whose OWN value is a link, reinterpreted through a capped schema:
    // nothing recorded the cap, because key() was never called above this
    // address. The first key() has to seed from the link it starts at, or the
    // hop resolveLink finds at depth 0 is checked against the leaf schema —
    // which has no cap — and the session-scoped target leaks.
    const inner = runtime.getCell(
      space,
      "root-cap-inner",
      innerSchema,
      tx,
      "session",
    );
    inner.set({ field: "secret" });
    const holder = runtime.getCell(space, "root-cap-holder", undefined, tx);
    holder.set(inner as never);

    const capped = holder.asSchema(
      {
        ...innerSchema,
        asCell: [{ kind: "cell", scope: "space" }],
      } as JSONSchema,
    );
    expect(capped.key("field").getAsNormalizedFullLink().scopeCaps)
      .toEqual([{ depth: 0, scope: "space" }]);
    expect(capped.key("field").get()).toBeUndefined();
  });

  it("keeps caps across asSchema, so reinterpreting cannot lift one", () => {
    // asSchema() makes a sibling at the SAME address with a different schema.
    // The recorded caps describe how this address was reached, which that
    // reinterpretation does not change — and dropping them would turn
    // asSchema() into a way to read past any cap. Read-boundary helpers like
    // cellWithScopedLinkRequiredsRelaxed are asSchema calls, so they have to
    // carry the caps through too.
    const r = build("as-schema", "space", "session");
    const uncapped = {
      ...innerSchema,
      asCell: ["cell"],
    } as JSONSchema;
    const reinterpreted = r.outer.key("handle").asSchema(uncapped);
    expect(reinterpreted.getAsNormalizedFullLink().scopeCaps)
      .toEqual([{ depth: 1, scope: "space" }]);
    expect(reinterpreted.key("field").get()).toBeUndefined();
  });
});

//
// Shapes the first round of this change missed, each found by adversarial
// review rather than by the tests above.
//

describe("asCell scope cap, harder shapes", () => {
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

  const sessionInner = (cause: string) => {
    const inner = runtime.getCell(space, cause, innerSchema, tx, "session");
    inner.set({ field: "secret" });
    return inner;
  };

  it("caps an array element handle", () => {
    // The motivating shape: a space-scoped list whose element handles must
    // point somewhere every reader in the space can resolve. Array elements
    // reach the boundary with the element's link already stepped past, so the
    // handle is built from the target address rather than from a sigil.
    const inner = sessionInner("arr-inner");
    const outer = runtime.getCell(
      space,
      "arr-outer",
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              ...innerSchema,
              asCell: [{ kind: "cell", scope: "space" }],
            },
          },
        },
        required: ["items"],
      } as JSONSchema,
      tx,
    );
    outer.set({ items: [inner] } as never);

    const readHandle = (v: unknown) =>
      isCell(v) ? (v as { get(): unknown }).get() : v;

    const viaKey = outer.key("items").get() as unknown[];
    expect(readHandle(viaKey[0])).toBeUndefined();
    const viaWhole = (outer.get() as { items: unknown[] }).items;
    expect(readHandle(viaWhole[0])).toBeUndefined();
    expect(readHandle(outer.key("items", "0").get())).toBeUndefined();
  });

  it("caps a handle below a link the resolver already followed", () => {
    // `outer`'s own value is a link to `mid`, so resolution consumes a hop
    // before it ever reaches the capped handle. Caps recorded for the
    // remaining segments have to travel across that hop.
    const inner = sessionInner("hop-inner");
    const mid = runtime.getCell(space, "hop-mid", undefined, tx);
    mid.set({ handle: inner } as never);
    const outer = runtime.getCell(space, "hop-outer", undefined, tx);
    outer.set(mid as never);

    const capped = outer.asSchema(
      {
        type: "object",
        properties: {
          handle: {
            ...innerSchema,
            asCell: [{ kind: "cell", scope: "space" }],
          },
        },
        required: ["handle"],
      } as JSONSchema,
    );
    expect(capped.key("handle", "field").get()).toBeUndefined();
    const projected = capped.key("handle").get();
    expect(
      isCell(projected) ? (projected as { get(): unknown }).get() : projected,
    )
      .toBeUndefined();
  });

  it("lets asSchema tighten a cap it cannot loosen", () => {
    // A looser cap recorded at a depth must not shadow a tighter one declared
    // for the same depth by a later asSchema().
    const inner = sessionInner("tighten-inner");
    const outer = runtime.getCell(
      space,
      "tighten-outer",
      {
        type: "object",
        properties: {
          handle: {
            ...innerSchema,
            asCell: [{ kind: "cell", scope: "session" }],
          },
        },
        required: ["handle"],
      } as JSONSchema,
      tx,
    );
    outer.set({ handle: inner } as never);

    // The permissive cap reads through, as it should.
    expect(outer.key("handle", "field").get()).toBe("secret");
    // Re-declaring it tighter blocks, on both routes.
    const tightened = outer.key("handle").asSchema(
      {
        ...innerSchema,
        asCell: [{ kind: "cell", scope: "space" }],
      } as JSONSchema,
    );
    expect(tightened.key("field").get()).toBeUndefined();
  });

  it("applies the leaf cap to an ancestor hop of a directly-built link", () => {
    // A link assembled without key() carries no recorded caps, so only the
    // leaf-schema floor in schemaScopeForLinkAtDepth can answer for a hop
    // found at an ancestor. Removing that floor lets this read through.
    const inner = sessionInner("floor-inner");
    const holder = runtime.getCell(space, "floor-holder", undefined, tx);
    holder.set({ a: inner } as never);
    const base = holder.getAsNormalizedFullLink();
    const atLeaf = (schema: JSONSchema) =>
      runtime.getCellFromLink({ ...base, path: ["a", "field"] }, schema, tx);

    // Control: with no cap anywhere the ancestor hop is followed.
    expect(atLeaf({ type: "string" } as JSONSchema).get()).toBe("secret");
    const capped = atLeaf({ type: "string", scope: "space" } as JSONSchema);
    expect(capped.getAsNormalizedFullLink().scopeCaps).toBeUndefined();
    expect(capped.get()).toBeUndefined();
  });

  it("does not invent a cap from `scope` beside an uncapped asCell", () => {
    // `scope` on a node also means "this value lives at that scope". Only the
    // asCell entry's own scope is a follow cap at a handle boundary.
    const inner = sessionInner("noinvent-inner");
    const outer = runtime.getCell(
      space,
      "noinvent-outer",
      {
        type: "object",
        properties: {
          handle: { ...innerSchema, asCell: ["cell"], scope: "space" },
        },
        required: ["handle"],
      } as JSONSchema,
      tx,
    );
    outer.set({ handle: inner } as never);
    const projected = outer.key("handle").get();
    expect(
      isCell(projected) ? (projected as { get(): unknown }).get() : projected,
    )
      .toEqual({ field: "secret" });
  });

  it("refuses writes through a blocked handle", () => {
    const inner = sessionInner("write-inner");
    const outer = runtime.getCell(
      space,
      "write-outer",
      {
        type: "object",
        properties: {
          handle: {
            ...innerSchema,
            asCell: [{ kind: "cell", scope: "space" }],
          },
        },
        required: ["handle"],
      } as JSONSchema,
      tx,
    );
    outer.set({ handle: inner } as never);

    const blocked = outer.key("handle").get();
    expect(isCell(blocked)).toBe(true);
    expect(() =>
      (blocked as { set(v: unknown): void }).set({ field: "hacked" })
    )
      .toThrow();
    expect(inner.get()).toEqual({ field: "secret" });
  });
});

describe("asCell scope cap, positional and compound", () => {
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

  const scopedInner = (cause: string, scope: "space" | "user" | "session") => {
    const inner = runtime.getCell(space, cause, innerSchema, tx, scope);
    inner.set({ field: "secret" });
    return inner;
  };

  it("caps a handle below a NON-ROOT ancestor link", () => {
    // The rebase across a hop shifts recorded cap depths onto the target's
    // path. With the ancestor link at the root (depth 0) the shift is 0 either
    // way, so an off-by-depth error hides. Here the link sits at `wrap`
    // (depth 1) and the cap at `wrap/handle` (depth 2), so a wrong shift files
    // the cap under a depth the hop never asks about and the read leaks.
    const inner = scopedInner("nonroot-inner", "session");
    const mid = runtime.getCell(space, "nonroot-mid", undefined, tx);
    mid.set({ handle: inner } as never);
    const outer = runtime.getCell(space, "nonroot-outer", undefined, tx);
    outer.set({ wrap: mid } as never);

    const capped = outer.asSchema(
      {
        type: "object",
        properties: {
          wrap: {
            type: "object",
            properties: {
              handle: {
                ...innerSchema,
                asCell: [{ kind: "cell", scope: "space" }],
              },
            },
            required: ["handle"],
          },
        },
        required: ["wrap"],
      } as JSONSchema,
    );
    expect(capped.key("wrap", "handle", "field").get()).toBeUndefined();
  });

  it("enforces a cap wrapped in anyOf on every route", () => {
    // `{anyOf: [<capped handle>, {type:"null"}]}` is a real shape here.
    // Reading only the top level for an asCell entry made it a cap bypass.
    const inner = scopedInner("anyof-inner", "session");
    const outer = runtime.getCell(
      space,
      "anyof-outer",
      {
        type: "object",
        properties: {
          handle: {
            anyOf: [
              { ...innerSchema, asCell: [{ kind: "cell", scope: "space" }] },
              { type: "null" },
            ],
          },
        },
        required: ["handle"],
      } as JSONSchema,
      tx,
    );
    outer.set({ handle: inner } as never);

    expect(outer.key("handle", "field").get()).toBeUndefined();
    const projected = outer.key("handle").get();
    expect(
      isCell(projected) ? (projected as { get(): unknown }).get() : projected,
    ).toBeUndefined();
  });

  it("keeps caps positional: a narrow cap below does not block a wide hop", () => {
    // Why scopeCaps records a DEPTH rather than collapsing to one cap.
    // `myProfile` is capped at `user` and legitimately holds a user-scoped
    // link; the `profile` inside it is capped at `space`. Each cap governs the
    // hop at its OWN position. Collapsing to the narrowest (`space`) would
    // block the user-scoped hop at `myProfile`, which is exactly the shape
    // pattern-scope.test.ts builds.
    const profile = scopedInner("pos-profile", "space");
    const myProfile = runtime.getCell(
      space,
      "pos-myprofile",
      undefined,
      tx,
      "user",
    );
    myProfile.set({ profile } as never);
    const root = runtime.getCell(space, "pos-root", undefined, tx);
    root.set({ myProfile } as never);

    const capped = root.asSchema(
      {
        type: "object",
        properties: {
          myProfile: {
            type: "object",
            properties: {
              profile: {
                ...innerSchema,
                asCell: [{ kind: "cell", scope: "space" }],
              },
            },
            required: ["profile"],
            asCell: [{ kind: "cell", scope: "user" }],
          },
        },
        required: ["myProfile"],
      } as JSONSchema,
    );

    // The user-scoped hop at `myProfile` is permitted by ITS cap...
    const handle = capped.key("myProfile").get();
    expect(isCell(handle)).toBe(true);
    // ...and the space-scoped profile below it reads through.
    expect(capped.key("myProfile", "profile", "field").get()).toBe("secret");
  });
});

describe("asCell scope cap, through definitions", () => {
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

  it("writes and dereferences a handle whose definition names itself", () => {
    // What `type Recursive = Cell<Recursive> | null` generates: resolving the
    // handle branch leads back to the union that holds it.
    const recursive = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Recursive" } },
      required: ["node"],
      $defs: {
        Recursive: {
          anyOf: [
            { type: "null" },
            { $ref: "#/$defs/Recursive", asCell: ["cell"] },
          ],
        },
      },
    } as const satisfies JSONSchema;
    const holder = runtime.getCell(space, "recursive-holder", undefined, tx)
      .asSchema(recursive);

    holder.key("node").set(null);

    // Read raw: projecting a value through this schema is a separate question
    // from where the write lands and what dereferencing it reaches.
    expect(
      tx.readValueOrThrow(holder.key("node").getAsNormalizedFullLink()),
    ).toBeNull();
    expect(isCell(holder.key("node").resolveAsCell())).toBe(true);
  });

  it("caps a handle branch that repeats its compound's reference in either form", () => {
    // The branch names the definition its compound is already expanding, and
    // its own entry still bounds the follow, however the schema travels.
    const secret = runtime.getCell(
      space,
      "repeated-ref-secret",
      { type: "string" },
      tx,
      "session",
    );
    secret.set("session value");
    const holder = runtime.getCell(space, "repeated-ref-holder", undefined, tx);
    holder.set(secret as never);
    const inline = {
      $ref: "#/$defs/R",
      anyOf: [
        { $ref: "#/$defs/R", asCell: [{ kind: "cell", scope: "user" }] },
        { type: "null" },
      ],
      $defs: { R: { type: "string" } },
    } as const satisfies JSONSchema;
    const stored = externalizeSchema(structuredClone(inline) as never);
    expect((stored as { $ref?: string }).$ref).toMatch(/^cid:/);

    expect(holder.asSchema(inline).resolveAsCell().get()).toBeUndefined();
    expect(holder.asSchema(stored).resolveAsCell().get()).toBeUndefined();
  });

  it("caps a handle inside a repeated reference's own compound in either form", () => {
    // The inner position names the same definition as the outer one but
    // carries a compound of its own, whose handle bounds the follow.
    const secret = runtime.getCell(
      space,
      "nested-compound-secret",
      { type: "string" },
      tx,
      "session",
    );
    secret.set("session value");
    const holder = runtime.getCell(
      space,
      "nested-compound-holder",
      undefined,
      tx,
    );
    holder.set(secret as never);
    const inline = {
      $ref: "#/$defs/R",
      anyOf: [
        {
          $ref: "#/$defs/R",
          anyOf: [
            { type: "string", asCell: [{ kind: "cell", scope: "user" }] },
            { type: "null" },
          ],
        },
        { type: "null" },
      ],
      $defs: { R: { type: "string" } },
    } as const satisfies JSONSchema;
    const stored = externalizeSchema(structuredClone(inline) as never);
    expect((stored as { $ref?: string }).$ref).toMatch(/^cid:/);

    expect(holder.asSchema(inline).resolveAsCell().get()).toBeUndefined();
    expect(holder.asSchema(stored).resolveAsCell().get()).toBeUndefined();
  });

  it("caps a branch's handle by the owning document's definition, not one nested in the branch", () => {
    // A `$defs` below the root is inert, so the nested `session` entry does
    // not loosen the `user` cap the root's `Handle` declares.
    const secret = runtime.getCell(
      space,
      "nested-defs-secret",
      { type: "string" },
      tx,
      "session",
    );
    secret.set("session value");
    const holder = runtime.getCell(space, "nested-defs-holder", undefined, tx);
    holder.set(secret as never);

    const capped = holder.asSchema(
      {
        anyOf: [{
          anyOf: [{ $ref: "#/$defs/Handle" }, { type: "null" }],
          $defs: {
            Handle: {
              type: "string",
              asCell: [{ kind: "cell", scope: "session" }],
            },
          },
        }],
        $defs: {
          Handle: {
            type: "string",
            asCell: [{ kind: "cell", scope: "user" }],
          },
        },
      } as JSONSchema,
    );

    expect(capped.resolveAsCell().get()).toBeUndefined();
  });
});

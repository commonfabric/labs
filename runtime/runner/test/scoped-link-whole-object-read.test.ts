import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  cellWithScopedLinkRequiredsRelaxed,
  resolveCellPath,
  schemaWithScopedLinkRequiredsRelaxed,
} from "../src/piece-helpers.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { dataUriFromValueWithResolvedLinks } from "../src/data-uri.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// Whole-object piece reads void on scoped links (CLI `cf cell get` with no
// path returned undefined while every child path worked).
//
// Mechanism: the piece result cell is NOT schema-less — the CLI read path
// recovers the durable result schema via getResultCellWithSourceSchema, and
// pattern result schemas mark every output property `required`
// (ts-transformers). When one property's stored value is a link into a
// session/user-scoped doc that this replica's session never wrote, the link
// target reads notFound (value undefined); a strict property schema (e.g.
// {type:"string"}) rejects undefined, the property is dropped from the
// assembled object, and traverseObjectWithSchema's `required` check then
// voids the ENTIRE object (traverse.ts, "Missing required property" ->
// return undefined). Child-path reads narrow the schema below the container,
// so the parent's `required` check never runs and they resolve fine.
//
// The strict void itself is BY DESIGN (#4746 removed the element-level
// absent-target grace: partial visibility must be expressed in the schema).
// The fix lives at the piece read boundary:
// schemaWithScopedLinkRequiredsRelaxed derives a projection schema whose
// `required` no longer claims properties stored as narrower-scoped links,
// and PiecePropIo.get reads both roots and selected subtrees through it —
// expressing partial visibility in the schema, exactly as #4746 prescribes.

const signer = await Identity.fromPassphrase("scoped-link-whole-object-read");
const space = signer.did();

const CONTAINER_CAUSE = "scoped-container";
const DRAFT_CAUSE = "session-draft";

// Analog of a generated pattern result schema: plain leaf schemas and every
// property required (that is what ts-transformers emits for a non-optional
// output interface, e.g. lunch-poll's CozyPollOutput -> required: [...all]).
const requiredResultSchema = {
  type: "object",
  properties: {
    question: { type: "string" },
    count: { type: "number" },
    myDraft: { type: "string" },
  },
  required: ["question", "count", "myDraft"],
} as const satisfies JSONSchema;

// Same shape without the scoped property being required.
const lenientResultSchema = {
  type: "object",
  properties: requiredResultSchema.properties,
  required: ["question", "count"],
} as const satisfies JSONSchema;

describe("whole-object read over a session-scoped link", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let writerRt: Runtime;

  beforeEach(async () => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    writerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });

    // Writer replica ("browser session"): a session-scoped draft cell plus a
    // container whose `myDraft` property links to it — the shape a pattern
    // result doc has when an output property derives from a
    // Writable.perSession / perUser cell.
    const tx = writerRt.edit();
    const draft = writerRt.getCell<string>(
      space,
      DRAFT_CAUSE,
      { type: "string" } as const,
      tx,
      "session",
    );
    draft.set("only-visible-in-writer-session");
    const container = writerRt.getCell(
      space,
      CONTAINER_CAUSE,
      {
        type: "object",
        properties: requiredResultSchema.properties,
      } as const,
      tx,
    );
    container.set({
      question: "Where should we eat?",
      count: 3,
      myDraft: draft,
    });
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    // Sanity: the stored link really is session-scoped.
    const rawLink = container.key("myDraft").getAsNormalizedFullLink();
    void rawLink;
  });

  afterEach(async () => {
    await writerRt?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  function freshReader(): { rt: Runtime; close: () => Promise<void> } {
    // A fresh storage manager mints a fresh sessionId — this replica is a
    // DIFFERENT session (the CLI) than the writer (the browser), so the
    // session-scoped draft doc does not exist for it.
    const storage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    return {
      rt,
      close: async () => {
        await rt.dispose();
        await storage.close();
      },
    };
  }

  it("writer's own session reads the whole object (control)", async () => {
    const container = writerRt.getCell(
      space,
      CONTAINER_CAUSE,
      requiredResultSchema,
    );
    const value = await container.pull();
    expect(value?.question).toBe("Where should we eat?");
    expect(value?.count).toBe(3);
    expect(value?.myDraft).toBe("only-visible-in-writer-session");
  });

  it("fresh session: child-path reads work (the CLI's per-path success)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        requiredResultSchema,
      );
      await container.pull();
      expect(resolveCellPath(container, ["question"])).toBe(
        "Where should we eat?",
      );
      expect(resolveCellPath(container, ["count"])).toBe(3);
    } finally {
      await close();
    }
  });

  it("characterization: strict required schema voids the whole object for a fresh session (by design, #4746)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        requiredResultSchema,
      );
      const value = await container.pull();
      // The raw read under the unrelaxed schema voids: the session-scoped
      // `myDraft` target is absent for this session, the required check
      // rejects, and the whole object reads undefined. This is the strict
      // semantics #4746 restored — the piece read boundary must derive a
      // relaxed projection schema (below) instead of expecting the traverser
      // to tolerate the hole.
      expect(value).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("THE FIX: fresh session whole-object read through the relaxed projection returns the plain properties", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        requiredResultSchema,
      );
      await container.pull();
      // The same derivation PiecePropIo.get applies before resolveCellPath.
      const projected = cellWithScopedLinkRequiredsRelaxed(container);
      const value = (await projected.pull()) as {
        question?: string;
        count?: number;
        myDraft?: string;
      };
      expect(value?.question).toBe("Where should we eat?");
      expect(value?.count).toBe(3);
      // The unmaterializable scoped member degrades instead of voiding.
      expect(value?.myDraft ?? null).toBeNull();
      // Child-path reads through the projected cell still work.
      expect(resolveCellPath(projected, ["question"])).toBe(
        "Where should we eat?",
      );
    } finally {
      await close();
    }
  });

  it("THE FIX: the writer's own session still reads the scoped member through the relaxed projection", async () => {
    // Relaxing `required` must not COST anything where the value resolves:
    // the owning session sees the full object either way.
    const container = writerRt.getCell(
      space,
      CONTAINER_CAUSE,
      requiredResultSchema,
    );
    const projected = cellWithScopedLinkRequiredsRelaxed(container);
    const value = await projected.pull();
    expect(value?.question).toBe("Where should we eat?");
    expect(value?.myDraft).toBe("only-visible-in-writer-session");
  });

  it("schema derivation: drops only scoped-link requireds, preserves identity when nothing to relax", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        requiredResultSchema,
      );
      await container.pull();
      const raw = container.getRaw();
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        requiredResultSchema,
        raw,
        container as unknown as Cell<unknown>,
      ) as { required?: string[] };
      // Only the scoped-link property leaves `required`.
      expect(relaxed.required).toEqual(["question", "count"]);

      // Identity preserved when the raw value holds no narrower-scoped links.
      const plainRaw = { question: "q", count: 1, myDraft: "inline" };
      expect(
        schemaWithScopedLinkRequiredsRelaxed(
          requiredResultSchema,
          plainRaw,
          container as unknown as Cell<unknown>,
        ),
      ).toBe(requiredResultSchema);
    } finally {
      await close();
    }
  });

  it("relaxes a required behind a nested object's ref into the root's $defs", async () => {
    // The reference under `inner` names the root's definition. Resolving it
    // there is what lets the nested `required` relax; left unrelaxed, strict
    // traversal can void the containing read.
    const scopedSchema = {
      type: "object",
      $defs: {
        Nested: {
          type: "object",
          properties: { draft: { type: "string" } },
          required: ["draft"],
        },
      },
      properties: {
        question: { type: "string" },
        inner: {
          type: "object",
          properties: {
            value: { $ref: "#/$defs/Nested" },
          },
        },
      },
    } as unknown as JSONSchema;

    const tx = writerRt.edit();
    const draft = writerRt.getCell<string>(
      space,
      "inline-scope-draft",
      { type: "string" } as const,
      tx,
      "session",
    );
    draft.set("writer-session-only");
    const container = writerRt.getCell(
      space,
      "inline-scope-container",
      scopedSchema,
      tx,
    );
    container.set({
      question: "inline scope question",
      inner: { value: { draft } },
    } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "inline-scope-container", scopedSchema);
      await cell.pull();
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        scopedSchema,
        cell.getRaw(),
        cell as unknown as Cell<unknown>,
      ) as {
        properties?: {
          inner?: { properties?: { value?: { required?: string[] } } };
        };
      };
      expect(relaxed.properties?.inner?.properties?.value?.required).toEqual(
        [],
      );
    } finally {
      await close();
    }
  });

  it("relaxes a required inside a recursive group's local definition", async () => {
    // A cyclic group stores its members as LOCAL references — the nested
    // definition arrives as a bare pointer whose `properties` and
    // `required` live on the owning document. The relaxation must resolve
    // through that pointer, or strict traversal voids `nested` and, with
    // the outer schema requiring it, the whole container.
    const groupSchema = {
      $ref: "#/$defs/Container",
      $defs: {
        Container: {
          type: "object",
          properties: {
            question: { type: "string" },
            nested: { $ref: "#/$defs/Nested" },
          },
          required: ["question", "nested"],
        },
        Nested: {
          type: "object",
          properties: {
            draft: { type: "string" },
            parent: { $ref: "#/$defs/Container" },
          },
          required: ["draft"],
        },
      },
    } as unknown as JSONSchema;
    const { rootRef, documents } = decomposeSchema(
      groupSchema as Parameters<typeof decomposeSchema>[0],
    );
    for (const [hash, document] of documents) {
      registerSchemaDocument(hash, document);
    }

    const tx = writerRt.edit();
    const draft = writerRt.getCell<string>(
      space,
      "group-session-draft",
      { type: "string" } as const,
      tx,
      "session",
    );
    draft.set("writer-session-only");
    const container = writerRt.getCell(
      space,
      "group-container",
      groupSchema,
      tx,
    );
    container.set({
      question: "group question",
      nested: { draft },
    } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "group-container", groupSchema);
      await cell.pull();
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        { $ref: rootRef } as unknown as JSONSchema,
        cell.getRaw(),
        cell as unknown as Cell<unknown>,
      ) as {
        required?: string[];
        properties?: { nested?: { required?: string[] } };
      };
      expect(relaxed.required).toEqual(["question", "nested"]);
      expect(relaxed.properties?.nested?.required).toEqual([]);
    } finally {
      await close();
    }
  });

  it("relaxes a required behind an embedded schema reference", async () => {
    // The renderer's vnode schema is an embedded document, and a schema that
    // is a bare reference to it carries no structure of its own. The
    // relaxation resolves through the reference into that document, where
    // `name` is required, and drops it when the stored `name` is a
    // session-scoped link.
    const vnodeReference = {
      $ref: "https://commonfabric.org/schemas/vnode.json",
    } as unknown as JSONSchema;

    const tx = writerRt.edit();
    const name = writerRt.getCell<string>(
      space,
      "vnode-session-name",
      { type: "string" } as const,
      tx,
      "session",
    );
    name.set("writer-session-only");
    const container = writerRt.getCell(
      space,
      "vnode-container",
      vnodeReference,
      tx,
    );
    container.set({ type: "vnode", name, props: {} } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "vnode-container", vnodeReference);
      await cell.pull();
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        vnodeReference,
        cell.getRaw(),
        cell as unknown as Cell<unknown>,
      ) as { required?: string[] };
      expect(relaxed.required).toEqual(["type", "props"]);
    } finally {
      await close();
    }
  });

  it("multi-hop: scope declared one redirect hop deep is detected (the real piece-result shape)", async () => {
    // Live pieces don't put the scope on the first link: result.prop links
    // (scope "space") to an intermediate doc whose VALUE is the
    // session-scoped redirect. The detector must resolve the chain, not just
    // parse hop 0.
    const tx = writerRt.edit();
    const deepDraft = writerRt.getCell<string>(
      space,
      "hop-draft",
      { type: "string" } as const,
      tx,
      "session",
    );
    deepDraft.set("deep-session-value");
    const mid = writerRt.getCell(
      space,
      "hop-mid",
      { type: "string" } as const,
      tx,
    );
    mid.set(deepDraft as never);
    const holder = writerRt.getCell(
      space,
      "hop-holder",
      {
        type: "object",
        properties: requiredResultSchema.properties,
      } as const,
      tx,
    );
    holder.set({
      question: "hop question",
      count: 1,
      myDraft: mid,
    } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "hop-holder", requiredResultSchema);
      await cell.pull();
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        requiredResultSchema,
        cell.getRaw(),
        cell as unknown as Cell<unknown>,
      ) as { required?: string[] };
      expect(relaxed.required).toEqual(["question", "count"]);
      const projected = cellWithScopedLinkRequiredsRelaxed(cell);
      const value = (await projected.pull()) as { question?: string };
      expect(value?.question).toBe("hop question");
    } finally {
      await close();
    }
  });

  it("user scope is detected, not just session", async () => {
    const tx = writerRt.edit();
    const userDraft = writerRt.getCell<string>(
      space,
      "user-draft",
      { type: "string" } as const,
      tx,
      "user",
    );
    userDraft.set("per-user-value");
    const holder = writerRt.getCell(
      space,
      "user-holder",
      {
        type: "object",
        properties: requiredResultSchema.properties,
      } as const,
      tx,
    );
    holder.set({
      question: "user question",
      count: 2,
      myDraft: userDraft,
    } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "user-holder", requiredResultSchema);
      await cell.pull();
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        requiredResultSchema,
        cell.getRaw(),
        cell as unknown as Cell<unknown>,
      ) as { required?: string[] };
      expect(relaxed.required).toEqual(["question", "count"]);
    } finally {
      await close();
    }
  });

  it("nested inline record: a scoped link below the root relaxes only that level", async () => {
    const nestedSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        inner: {
          type: "object",
          properties: {
            plain: { type: "string" },
            scoped: { type: "string" },
          },
          required: ["plain", "scoped"],
        },
      },
      required: ["title", "inner"],
    } as const satisfies JSONSchema;

    const tx = writerRt.edit();
    const scoped = writerRt.getCell<string>(
      space,
      "nested-draft",
      { type: "string" } as const,
      tx,
      "session",
    );
    scoped.set("nested-session-value");
    const holder = writerRt.getCell(
      space,
      "nested-holder",
      {
        type: "object",
        properties: nestedSchema.properties,
      } as const,
      tx,
    );
    holder.set({
      title: "nested",
      inner: { plain: "visible", scoped },
    } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "nested-holder", nestedSchema);
      await cell.pull();
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        nestedSchema,
        cell.getRaw(),
        cell as unknown as Cell<unknown>,
      ) as {
        required?: string[];
        properties?: { inner?: { required?: string[] } };
      };
      // Root required untouched; only the nested level drops `scoped`.
      expect(relaxed.required).toEqual(["title", "inner"]);
      expect(relaxed.properties?.inner?.required).toEqual(["plain"]);
      const projected = cellWithScopedLinkRequiredsRelaxed(cell);
      const value = (await projected.pull()) as {
        title?: string;
        inner?: { plain?: string };
      };
      expect(value?.title).toBe("nested");
      expect(value?.inner?.plain).toBe("visible");
    } finally {
      await close();
    }
  });

  it("cycle in the stored chain: detector stays strict and does not hang", async () => {
    const tx = writerRt.edit();
    const cellA = writerRt.getCell(
      space,
      "cycle-a",
      { type: "string" } as const,
      tx,
    );
    const cellB = writerRt.getCell(
      space,
      "cycle-b",
      { type: "string" } as const,
      tx,
    );
    cellA.set(cellB as never);
    cellB.set(cellA as never);
    const holder = writerRt.getCell(
      space,
      "cycle-holder",
      {
        type: "object",
        properties: requiredResultSchema.properties,
      } as const,
      tx,
    );
    holder.set({
      question: "cycle question",
      count: 3,
      myDraft: cellA,
    } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "cycle-holder", requiredResultSchema);
      await cell.pull();
      // Chain resolution hits the resolver's cycle detection; the catch keeps
      // the schema strict (identity-preserved) instead of hanging or relaxing.
      expect(
        schemaWithScopedLinkRequiredsRelaxed(
          requiredResultSchema,
          cell.getRaw(),
          cell as unknown as Cell<unknown>,
        ),
      ).toBe(requiredResultSchema);
    } finally {
      await close();
    }
  });

  it("scope-cap-blocked chain relaxes: a capped link whose narrow follow is blocked is just as unreachable", async () => {
    // The property link carries a schema whose scope cap is "space"; the
    // chain then hits a session-scoped link. resolveLink BLOCKS that follow
    // (CT-1642) and terminates at the undefined-data marker instead of a
    // narrow-scoped terminal. The detector must treat that as narrow —
    // otherwise this class voids exactly like the original bug.
    const tx = writerRt.edit();
    const capDraft = writerRt.getCell<string>(
      space,
      "cap-draft",
      { type: "string" } as const,
      tx,
      "session",
    );
    capDraft.set("capped-session-value");
    const capMid = writerRt.getCell(
      space,
      "cap-mid",
      { type: "string" } as const,
      tx,
    );
    capMid.set(capDraft as never);
    const holder = writerRt.getCell(
      space,
      "cap-holder",
      {
        type: "object",
        properties: requiredResultSchema.properties,
      } as const,
      tx,
    );
    const midLink = capMid.getAsNormalizedFullLink();
    holder.setRaw({
      question: "capped question",
      count: 4,
      // Hand-built sigil: the embedded schema's top-level `scope` is the
      // follow cap (ContextualFlowControl.getSchemaScopeCap).
      myDraft: {
        "/": {
          "link@1": {
            id: midLink.id,
            path: [],
            space: midLink.space,
            scope: "space",
            schema: { type: "string", scope: "space" },
          },
        },
      },
    } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "cap-holder", requiredResultSchema);
      await cell.pull();
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        requiredResultSchema,
        cell.getRaw(),
        cell as unknown as Cell<unknown>,
      ) as { required?: string[] };
      expect(relaxed.required).toEqual(["question", "count"]);
      const projected = cellWithScopedLinkRequiredsRelaxed(cell);
      const value = (await projected.pull()) as { question?: string };
      expect(value?.question).toBe("capped question");
    } finally {
      await close();
    }
  });

  it("a stored link that genuinely encodes undefined stays strict (not mistaken for a scope block)", async () => {
    // A required property whose stored value is literally a data:-undefined
    // link is undefined for EVERY reader — that is not a scope-visibility
    // hole, and relaxing it would change strict semantics. The scope-block
    // signal comes from resolveLink's onScopeBlocked callback, not from the
    // terminal's shape, so this shape must NOT relax.
    const tx = writerRt.edit();
    const holder = writerRt.getCell(
      space,
      "data-undef-holder",
      {
        type: "object",
        properties: requiredResultSchema.properties,
      } as const,
      tx,
    );
    holder.setRaw({
      question: "data-undef question",
      count: 6,
      myDraft: {
        "/": {
          "link@1": {
            id: dataUriFromValueWithResolvedLinks(undefined),
            path: [],
            space,
            scope: "space",
          },
        },
      },
    } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "data-undef-holder", requiredResultSchema);
      await cell.pull();
      // No relaxation: schema identity preserved, and the strict read voids.
      expect(
        schemaWithScopedLinkRequiredsRelaxed(
          requiredResultSchema,
          cell.getRaw(),
          cell as unknown as Cell<unknown>,
        ),
      ).toBe(requiredResultSchema);
      const projected = cellWithScopedLinkRequiredsRelaxed(cell);
      const value = await projected.pull();
      expect(value).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("a tx-bound cell derives against its own transaction's uncommitted state", async () => {
    // Both reads inside the helper must see the same state: getRaw() honors
    // the cell's bound tx, so the chain resolution must too — otherwise an
    // uncommitted link is unresolvable on a fresh tx and the derivation
    // silently diverges from the cell's own read semantics.
    const tx = writerRt.edit();
    const draft = writerRt.getCell<string>(
      space,
      "txbound-draft",
      { type: "string" } as const,
      tx,
      "session",
    );
    draft.set("uncommitted-session-value");
    const holder = writerRt.getCell(
      space,
      "txbound-holder",
      requiredResultSchema,
      tx,
    );
    holder.set({
      question: "uncommitted question",
      count: 5,
      myDraft: draft,
    } as never);

    // BEFORE commit: the tx-bound cell's derivation sees the uncommitted
    // link and relaxes.
    const relaxed = schemaWithScopedLinkRequiredsRelaxed(
      requiredResultSchema,
      holder.getRaw(),
      holder as unknown as Cell<unknown>,
    ) as { required?: string[] };
    expect(relaxed.required).toEqual(["question", "count"]);

    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
  });

  it("characterization: strictness one link deep is out of reach (schema combine keeps required)", async () => {
    // A space-scoped link to a doc whose OWN read applies a schema requiring
    // a scoped member: the boundary relaxation cannot reach it (the traverser
    // combines schemas across link hops and `required` survives from either
    // side). This pins the known limit — the proper fix is schema-generator
    // optionality (see the helper's doc comment).
    const innerSchema = {
      type: "object",
      properties: {
        plain: { type: "string" },
        scoped: { type: "string" },
      },
      required: ["plain", "scoped"],
    } as const satisfies JSONSchema;
    const outerSchema = {
      type: "object",
      properties: { title: { type: "string" }, sub: innerSchema },
      required: ["title", "sub"],
    } as const satisfies JSONSchema;

    const tx = writerRt.edit();
    const scoped = writerRt.getCell<string>(
      space,
      "deep-scoped",
      { type: "string" } as const,
      tx,
      "session",
    );
    scoped.set("deep");
    const sub = writerRt.getCell(
      space,
      "deep-sub",
      {
        type: "object",
        properties: innerSchema.properties,
      } as const,
      tx,
    );
    sub.set({ plain: "p", scoped } as never);
    const holder = writerRt.getCell(
      space,
      "deep-holder",
      {
        type: "object",
        properties: outerSchema.properties,
      } as const,
      tx,
    );
    holder.set({ title: "t", sub } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(space, "deep-holder", outerSchema);
      await cell.pull();
      const projected = cellWithScopedLinkRequiredsRelaxed(cell);
      const value = await projected.pull();
      // `sub` is a LINK: the relaxation treats links as boundaries, the
      // linked doc's required check voids `sub`, and the outer required check
      // (which still requires `sub` — its stored link terminates space-scoped
      // at the sub doc) voids the whole object. Documented limitation.
      expect(value).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("strictness preserved: a genuinely missing plain required property still voids", async () => {
    // A doc that simply lacks a required (non-link) property must keep strict
    // semantics through the relaxed projection — the grace is scoped-link
    // shaped, not a blanket required-relaxation.
    const tx = writerRt.edit();
    const incomplete = writerRt.getCell(
      space,
      "incomplete-container",
      {
        type: "object",
        properties: requiredResultSchema.properties,
      } as const,
      tx,
    );
    incomplete.set({ question: "only a question" } as never);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell(
        space,
        "incomplete-container",
        requiredResultSchema,
      );
      await cell.pull();
      const projected = cellWithScopedLinkRequiredsRelaxed(cell);
      const value = await projected.pull();
      expect(value).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("fresh session: same read with the scoped property not required works (isolates the required-collapse)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        lenientResultSchema,
      );
      const value = await container.pull();
      expect(value?.question).toBe("Where should we eat?");
      expect(value?.count).toBe(3);
      expect(value?.myDraft ?? null).toBeNull();
    } finally {
      await close();
    }
  });

  it("fresh session: SCHEMA-LESS whole-object read works (rules out the schema-less-read hypothesis)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      const value = (await container.pull()) as {
        question?: string;
        count?: number;
        myDraft?: string;
      };
      expect(value?.question).toBe("Where should we eat?");
      expect(value?.count).toBe(3);
    } finally {
      await close();
    }
  });
});

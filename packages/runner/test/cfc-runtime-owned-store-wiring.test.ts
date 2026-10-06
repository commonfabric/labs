import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { FactoryInput, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { enrollRuntimeOwnedStore } from "../src/builtins/runtime-owned-store.ts";
import { getTopFrame } from "../src/builder/pattern.ts";
import { parseLink } from "../src/link-utils.ts";
import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runtime owned store wiring");
const space = signer.did();
const elsewhere =
  (await Identity.fromPassphrase("runtime owned store elsewhere")).did();

/**
 * That the runner enrolls a running piece's own stores, that a builtin
 * enrolls the state stores it mints, and that both go when the piece stops.
 *
 * `cfc-writer-fit.test.ts` states the RULE against a hand-recorded marker.
 * These run a real piece, so they cover the wiring the rule rests on: which
 * transaction names the stores, and when the enrollment ends. A hand-recorded
 * marker cannot tell whether `Runner.#startCore()` registered anything at
 * all.
 */
describe("runtime-owned-store enrollment wiring", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * A source whose `secret` field carries `clause`. Each write wants its own:
   * a route-2 upgrade declares what it carried, so a second write reusing the
   * first's clause would fit the store's own declaration whatever the
   * enrollment says.
   */
  const seedSecret = async (name: string, clause = name) => {
    const seed = runtime.edit();
    const cell = runtime.getCell(space, name, {
      type: "object",
      properties: { secret: { type: "string" } },
    } as JSONSchema);
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value: { secret: "s3cr3t" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: [clause] },
          }],
        },
      },
      // deno-lint-ignore no-explicit-any
    } as any);
    expect((await seed.commit().settled).ok).toBeDefined();
  };

  /** Start a piece holding a list of its own, and hand back that list. */
  const startPiece = async (name: string) => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => ({
      notes: BuilderCell.of<string[]>([]),
    }));
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      name,
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    return { result, resultCell };
  };

  /**
   * Append what the seeded source carries to the piece's own list, on a fresh
   * transaction that names no store — the shape a reactive update has.
   */
  const appendSecret = async (
    result: Awaited<ReturnType<typeof startPiece>>["result"],
    sourceName: string,
    suffix: string,
  ) => {
    const tx = runtime.edit();
    tx.setCfcEnforcementMode("enforce-strict");
    const source = runtime.getCell(space, sourceName, undefined, tx);
    const raw = source.getRaw() as { secret?: string };
    // deno-lint-ignore no-explicit-any
    (result.withTx(tx) as any).key("notes").set([`${raw.secret}/${suffix}`]);
    tx.prepareCfc();
    return await tx.commit().settled;
  };

  it("enrolls a running piece's stores, so a later write declares", async () => {
    // The write runs on a transaction of its own, which names nothing: the
    // enrollment the instantiation made is the whole of what reaches it.
    await seedSecret("wiring-append-source");
    const { result } = await startPiece("wiring-append");

    expect((await appendSecret(result, "wiring-append-source", "first")).error)
      .toBeUndefined();
  });

  it("declares on the piece's own result document", async () => {
    // The result document is on the route and the others are not enough to
    // put it there: a nested piece's result is `{resultFor}`, minted from a
    // node's cause, and the reactive update that first carried a label into
    // one is half of what this change exists for. It is also the member whose
    // paths an author CAN declare, so where a schema does, the route declines
    // and the misfit stands.
    await seedSecret("wiring-result-source");
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => ({
      note: BuilderCell.of(""),
    }));
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "wiring-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();

    // A later transaction naming no store, writing a labeled value into the
    // result DOCUMENT — addressed without the pattern's schema, at a path
    // that projects to no internal cell, so the write lands there and not in
    // something the manifest already covers.
    void result;
    const write = runtime.edit();
    write.setCfcEnforcementMode("enforce-strict");
    const source = runtime.getCell(
      space,
      "wiring-result-source",
      undefined,
      write,
    );
    const raw = source.getRaw() as { secret?: string };
    const document = runtime.getCell<{ scratch?: string }>(
      space,
      "wiring-result",
      undefined,
      write,
    );
    document.key("scratch").set(`${raw.secret}!`);
    write.prepareCfc();
    expect((await write.commit().settled).error).toBeUndefined();
  });

  it("enrolls no store a builtin minted outside the owner's space", () => {
    // A store elsewhere belongs to whoever holds that space's replicas, so a
    // policy declared on it out of this piece's flow join would put another
    // space's bytes behind a promise made here. The helper every builtin
    // holding state goes through is where that is settled, because the
    // enrollment key names an owner and a store outside the space has none.
    const tx = runtime.edit();
    const owner = runtime.getCell(space, "cross-space-owner", undefined, tx);
    const here = runtime.getCell(space, "cross-space-here", undefined, tx);
    const there = runtime.getCell(
      elsewhere,
      "cross-space-there",
      undefined,
      tx,
    );

    enrollRuntimeOwnedStore(tx, owner, here);
    enrollRuntimeOwnedStore(tx, owner, there);

    expect(
      tx.isRuntimeOwnedStore(
        space,
        here.getAsNormalizedFullLink().id,
        runtimeWritePolicyAuthorization,
      ),
    ).toBe(true);
    expect(
      tx.isRuntimeOwnedStore(
        elsewhere,
        there.getAsNormalizedFullLink().id,
        runtimeWritePolicyAuthorization,
      ),
    ).toBe(false);
    tx.abort("done");
  });

  it("lets them go when the piece stops", async () => {
    // Nothing may keep an enrollment alive past its piece: a list operation
    // mints one piece per element, so an enrollment that outlived its piece
    // would grow with every element a churning list ever held.
    await seedSecret("wiring-release-source");
    const { result, resultCell } = await startPiece("wiring-release");
    expect((await appendSecret(result, "wiring-release-source", "first")).error)
      .toBeUndefined();

    runtime.runner.stop(resultCell);

    // A clause the store's own declaration does not already cover, so the
    // route is what the write needs and the release is what took it away.
    await seedSecret("wiring-release-other");
    const refused = await appendSecret(
      result,
      "wiring-release-other",
      "second",
    );
    expect(refused.error?.message).toContain(
      "writer-fit confidentiality misfit",
    );
  });

  it("releases an element piece's stores when its element leaves the list", async () => {
    // A list operation mints one piece per element and stops it when the
    // element goes, so the enrollment must follow the piece rather than the
    // list: an element that left keeps its result document, and that
    // document is nobody's store any more.
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric;
    const doubled = pattern<{ values: number[] }>(({ values }) => ({
      values,
      // deno-lint-ignore no-explicit-any
      output: (values as any).mapWithPattern(
        pattern(({ element }: FactoryInput<any>) =>
          lift((value: number) => value * 2)(element)
        ),
        {},
      ),
    }));
    const values = Array.from({ length: 6 }, (_, index) => index);
    let tx = runtime.edit();
    const resultCell = runtime.getCell(space, "wiring-elements", undefined, tx);
    const result = runtime.run(tx, doubled, { values }, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.settled();
    await result.pull();

    // The container holds one link per element, to that element piece's
    // result document.
    const elementIds = () => {
      const read = runtime.edit();
      // The output spot links to a computed document, which links to the
      // container; the container holds one link per element. Follow links
      // until the array itself.
      let cell = result.withTx(read).key("output");
      let raw = cell.getRaw();
      while (!Array.isArray(raw)) {
        cell = runtime.getCellFromLink(parseLink(raw, cell)!, undefined, read);
        raw = cell.getRaw();
      }
      const ids = (raw as { "/": { "link@1": { id: string } } }[]).map(
        (entry) => entry["/"]["link@1"].id,
      );
      read.abort("read");
      return ids;
    };
    const owned = (id: string) => {
      const ask = runtime.edit();
      const answer = ask.isRuntimeOwnedStore(
        space,
        id,
        runtimeWritePolicyAuthorization,
      );
      ask.abort("ask");
      return answer;
    };
    const before = elementIds();
    expect(before.length).toBe(6);
    for (const id of before) expect(owned(id)).toBe(true);

    tx = runtime.edit();
    result.withTx(tx).key("values").set(values.slice(0, 2));
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.settled();
    await result.pull();

    const after = elementIds();
    expect(after).toEqual(before.slice(0, 2));
    for (const id of before.slice(0, 2)) expect(owned(id)).toBe(true);
    for (const id of before.slice(2)) expect(owned(id)).toBe(false);
  });

  describe("an element anchored inside a store the runtime owns", () => {
    // The anchored child takes the marker alone, recorded by the write that
    // anchors it. What that reaches and what it does not is the line an
    // author meets: a write that re-anchors the element commits, and a write
    // addressed into the existing child through its link is measured against
    // the child's own ceiling and refused. Both halves are pinned so the
    // refused one flips visibly when link-carried provenance (§8.12.8)
    // reaches it.

    const startListPiece = async (name: string) => {
      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern, Cell: BuilderCell } = commonfabric;
      const listPattern = pattern<Record<string, never>>(() => ({
        items: BuilderCell.of<{ note: string }[]>([], {
          type: "array",
          items: { type: "object", properties: { note: { type: "string" } } },
        }),
      }));
      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        name,
        listPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, listPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      return result;
    };

    /** Write what `sourceName` carries into the piece's list, per `shape`. */
    const writeLabeled = async (
      result: Awaited<ReturnType<typeof startListPiece>>,
      sourceName: string,
      // deno-lint-ignore no-explicit-any
      shape: (items: any, secret: string) => void,
    ) => {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(space, sourceName, undefined, tx);
      const raw = source.getRaw() as { secret?: string };
      // deno-lint-ignore no-explicit-any
      shape((result.withTx(tx) as any).key("items"), raw.secret!);
      tx.prepareCfc();
      return await tx.commit().settled;
    };

    it("puts each element in a document of its own with no handler or lift running", async () => {
      // What splits the element out is the id source `Cell.set` takes from
      // the frame its cell was made in. The `Runtime` constructor pushes a
      // frame that only disposal pops, so a cell made while a runtime is
      // alive carries one and every such write splits. Each write in this
      // describe is made from test code with neither a handler nor a lift
      // around it, and this reads the split they all rest on.

      const result = await startListPiece("wiring-anchor-plain");
      const tx = runtime.edit();

      // `withTx()` and `key()` each build a fresh cell, so the frame on top
      // here is the one the written cell captures: the runtime's own, being
      // neither a lift's nor a handler's.
      const frame = getTopFrame();
      expect(frame).toBeDefined();
      expect(frame?.frameKind).toBeUndefined();

      // deno-lint-ignore no-explicit-any
      const items = (result.withTx(tx) as any).key("items");
      items.set([{ note: "first" }, { note: "second" }]);

      const stored = items.getRaw({ lastNode: "value" }) as unknown[];
      const ids = stored.map((entry) => parseLink(entry, items)?.id);
      expect(ids).toEqual([expect.any(String), expect.any(String)]);
      expect(ids[0]).not.toBe(ids[1]);
      // `parseLink` resolves a path-relative link against the base it is
      // given, so an element stored as a link back into the list's own
      // document would answer with the list's id. Excluding it is what makes
      // this a separate document rather than a separate address.
      const container = items.getAsNormalizedFullLink().id;
      expect(ids).not.toContain(container);
      expect((await tx.commit().settled).error).toBeUndefined();
    });

    it("declares on the child the anchoring write mints", async () => {
      await seedSecret("anchor-append-source", "anchor-append");
      const result = await startListPiece("wiring-anchor-append");
      const appended = await writeLabeled(
        result,
        "anchor-append-source",
        (items, secret) => items.set([{ note: `${secret}/append` }]),
      );
      expect(appended.error).toBeUndefined();
    });

    it("commits a write that re-anchors the element", async () => {
      await seedSecret("anchor-rewrite-first", "anchor-rewrite-1");
      await seedSecret("anchor-rewrite-second", "anchor-rewrite-2");
      await seedSecret("anchor-rewrite-third", "anchor-rewrite-3");
      const result = await startListPiece("wiring-anchor-rewrite");
      expect(
        (await writeLabeled(
          result,
          "anchor-rewrite-first",
          (items, secret) => items.set([{ note: `${secret}/append` }]),
        )).error,
      ).toBeUndefined();
      // The whole list again, and the element alone: each puts an object at
      // the position, so each walks through the anchoring and marks the
      // child it mints.
      expect(
        (await writeLabeled(
          result,
          "anchor-rewrite-second",
          (items, secret) => items.set([{ note: `${secret}/rewrite` }]),
        )).error,
      ).toBeUndefined();
      expect(
        (await writeLabeled(
          result,
          "anchor-rewrite-third",
          (items, secret) => items.key(0).set({ note: `${secret}/element` }),
        )).error,
      ).toBeUndefined();
    });

    it("refuses a write addressed into the existing child", async () => {
      // The ordinary handler shape — one field of one existing item — and the
      // one this route does not reach: the write follows the link into the
      // child and finds no claim there.
      await seedSecret("anchor-field-first", "anchor-field-1");
      await seedSecret("anchor-field-second", "anchor-field-2");
      const result = await startListPiece("wiring-anchor-field");
      expect(
        (await writeLabeled(
          result,
          "anchor-field-first",
          (items, secret) => items.set([{ note: `${secret}/append` }]),
        )).error,
      ).toBeUndefined();
      const refused = await writeLabeled(
        result,
        "anchor-field-second",
        (items, secret) => items.key(0).key("note").set(`${secret}/field`),
      );
      expect(refused.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(refused.error?.message).toContain("at /note");
      expect(refused.error?.message).toContain('"anchor-field-2"');
    });
  });

  describe("an element anchored inside a store no piece owns", () => {
    // The other half of the same split. A child inherits the runtime-owned
    // claim only from a parent that carries one, so a child of an ordinary
    // authored document is measured against what the schema describing the
    // parent's value at the anchored position declares. The refusal names the
    // child, at an id no author wrote down, and lands at the child's root
    // whatever the declaration sits on inside the element.

    /** The holder these cases write their list into, under `schema`. */
    const holder = (name: string, schema: JSONSchema) =>
      runtime.getCell<{ items: { note: string }[] }>(space, name, schema);

    /** A list schema whose ELEMENT declares `clauses`, where any are given. */
    const listSchema = (...clauses: string[]): JSONSchema => ({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { note: { type: "string" } },
            ...(clauses.length > 0
              ? { ifc: { confidentiality: clauses } }
              : {}),
          },
        },
      },
    } as JSONSchema);

    /** Put what `sourceName` carries into `target`'s list, anchoring it. */
    const writeElement = async (
      target: ReturnType<typeof holder>,
      sourceName: string,
    ) => {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(space, sourceName, undefined, tx);
      const raw = source.getRaw() as { secret?: string };
      target.withTx(tx).set({ items: [{ note: `${raw.secret}/anchored` }] });
      tx.prepareCfc();
      return await tx.commit().settled;
    };

    it("refuses one whose parent declares nothing", async () => {
      await seedSecret("unowned-bare", "unowned-bare-clause");
      const refused = await writeElement(
        holder("wiring-unowned-bare", listSchema()),
        "unowned-bare",
      );
      expect(refused.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(refused.error?.message).toContain('"unowned-bare-clause"');
    });

    it("admits one the element's own declaration covers", async () => {
      await seedSecret("unowned-covered", "unowned-covered-clause");
      const committed = await writeElement(
        holder(
          "wiring-unowned-covered",
          listSchema("unowned-covered-clause"),
        ),
        "unowned-covered",
      );
      expect(committed.error).toBeUndefined();
    });

    it("refuses one the element declares a different clause for", async () => {
      await seedSecret("unowned-other", "unowned-other-clause");
      const refused = await writeElement(
        holder(
          "wiring-unowned-other",
          listSchema("some-other-clause"),
        ),
        "unowned-other",
      );
      expect(refused.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(refused.error?.message).toContain('"unowned-other-clause"');
    });

    it("refuses one declared on a field rather than on the element", async () => {
      // The anchoring write lands at the child's ROOT, so a declaration one
      // level in does not cover it, and the misfit says `at /` rather than
      // naming the field the clause was written for.
      await seedSecret("unowned-field", "unowned-field-clause");
      const fieldDeclared: JSONSchema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                note: {
                  type: "string",
                  ifc: { confidentiality: ["unowned-field-clause"] },
                },
              },
            },
          },
        },
      } as JSONSchema;
      const refused = await writeElement(
        holder("wiring-unowned-field", fieldDeclared),
        "unowned-field",
      );
      expect(refused.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(refused.error?.message).toContain("at /");
      expect(refused.error?.message).not.toContain("at /note");
      expect(refused.error?.message).toContain('"unowned-field-clause"');
    });
  });
});

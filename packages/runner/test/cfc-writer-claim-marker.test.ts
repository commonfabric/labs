import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimePresets } from "../src/runtime-presets.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import { cfcLabelViewForResolvedCell } from "../src/cfc/label-view.ts";
import { setCfcImplementationIdentity } from "../src/cfc/trust-authority.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";

// The marker the persist loop mints for a writer-claimed position that holds
// nothing yet: a declared entry with an empty label, which routes a later
// write there to the claim. What it must and must not do, each pinned on a
// raw document so the shape is exact:
//
// - it is minted where only a link, flow or structure entry stands at the
//   position, since none of those routes a link write (a link write
//   discounts the link entries at its slot) and flow stamps are cleared by
//   later writes;
// - it is minted for a claim on the items of a container, at the container,
//   so the container's first item write through a bare schema is routed;
// - it is not minted under an ancestor's declared entry, which already
//   routes writes beneath it — and which the marker would otherwise shadow
//   for reads, since the declared component resolves by longest prefix;
// - it declares no policy, so under declared-monotonicity enforcement the
//   writer's first write, which mints the position's real label, is a
//   creation and not an addition to an empty claim;
// - an item write on an absent claimed container, and a bare-link write at
//   an item, are refused by the claim and not by a type clash of an envelope
//   spelled at the index.

const signer = await Identity.fromPassphrase("cfc-writer-claim-marker");
const space = signer.did();

/** The builtin the claims name. */
const WRITER = "cfc-writer-claim-marker-writer";

type Doc = Record<string, unknown>;

describe("the marker for a writer-claimed position that holds nothing", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const newRuntime = (options: Record<string, unknown> = {}) =>
    new Runtime(
      {
        ...runtimePresets.patternTest({
          apiUrl: new URL(import.meta.url),
          storageManager,
          experimental: {},
        }),
        ...options,
      } as ConstructorParameters<typeof Runtime>[0],
    );

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = newRuntime();
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const asWriter = (write: (tx: IExtendedStorageTransaction) => void) =>
    runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: WRITER,
      });
      write(tx);
    });

  const asMember = (write: (tx: IExtendedStorageTransaction) => void) =>
    runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "sha256:member-code",
        symbol: "repoint",
        bindingPath: ["repoint"],
      });
      write(tx);
    });

  const create = async (name: string, schema: JSONSchema, value: Doc) => {
    const doc = runtime.getCell<Doc>(space, name, schema);
    expect(
      (await runtime.editWithRetry((tx) => {
        doc.withTx(tx).set(value);
      })).error,
    ).toBeUndefined();
    await runtime.storageManager.synced();
    return doc;
  };

  const entriesOf = (doc: Cell<unknown>): readonly LabelMapEntry[] => {
    const link = doc.getAsNormalizedFullLink();
    const tx = runtime.edit();
    try {
      const stored = loadStoredCfcEnvelope(tx, {
        space: link.space,
        id: link.id,
        scope: link.scope,
      });
      expect(stored.status).toBe("loaded");
      return stored.status === "loaded" ? stored.metadata.labelMap.entries : [];
    } finally {
      tx.abort();
    }
  };

  const declaredAt = (entries: readonly LabelMapEntry[], path: string[]) =>
    entries.find((entry) =>
      entry.origin === "declared" &&
      entry.path.length === path.length &&
      entry.path.every((segment, index) => segment === path[index])
    );

  const bare = (doc: Cell<unknown>, path: string[]) => {
    const { schema: _schema, ...link } = doc.getAsNormalizedFullLink();
    return { ...link, path: [...link.path, ...path] };
  };

  const refusedByClaim = (error: unknown, what: string) => {
    expect(error, `${what}: ${JSON.stringify(error)}`).toMatchObject({
      name: "CfcCommitRefusalError",
      reasons: [expect.stringMatching(/^writeAuthorizedBy /)],
    });
  };

  it("is minted where only a link entry stands at a slot the schema newly claims", async () => {
    // A room written under a schema that claims nothing, whose `box` holds
    // a link to a labeled document: the envelope carries a link-origin entry
    // at `box` and nothing else there.
    const unclaimed = {
      type: "object",
      properties: { box: { type: "object" }, note: { type: "string" } },
    } as JSONSchema;
    const box = runtime.getCell<Doc>(space, "linked-box", {
      type: "object",
      ifc: { confidentiality: [cfcAtom.space(space)] },
    } as JSONSchema);
    const room = await create("room-newly-claimed", unclaimed, { note: "" });
    expect(
      (await runtime.editWithRetry((tx) => {
        box.withTx(tx).set({ sealed: true });
        room.withTx(tx).key("box").set(box as never);
      })).error,
    ).toBeUndefined();
    await runtime.storageManager.synced();
    const before = entriesOf(room);
    expect(
      before.some((entry) =>
        entry.origin === "link" && entry.path[0] === "box"
      ),
    ).toBe(true);
    expect(declaredAt(before, ["box"])).toBeUndefined();

    // The room's next version claims `box` for the writer, and a write
    // under it that touches only `note` merges the claim into the envelope.
    // The link entry at `box` routes no link write, so the claim gets its
    // own marker.
    const claimed = {
      type: "object",
      properties: {
        box: { type: "object", ifc: { writeAuthorizedBy: [WRITER] } },
        note: { type: "string" },
      },
    } as JSONSchema;
    expect(
      (await runtime.editWithRetry((tx) => {
        runtime.getCell<Doc>(space, "room-newly-claimed", claimed, tx).update({
          note: "v2",
        });
      })).error,
    ).toBeUndefined();
    await runtime.storageManager.synced();
    const after = entriesOf(room);
    expect(declaredAt(after, ["box"])).toMatchObject({ label: {} });

    // A member replacing the link through a bare schema is refused.
    const other = runtime.getCell<Doc>(space, "other-box", {
      type: "object",
      ifc: { confidentiality: [cfcAtom.space(space)] },
    } as JSONSchema);
    refusedByClaim(
      (await asMember((tx) => {
        other.withTx(tx).set({ sealed: false });
        runtime.getCellFromLink(
          bare(room, ["box"]),
          { type: "object" } as JSONSchema,
          tx,
        ).set(other as never);
      })).error,
      "a bare link replace",
    );
    expect(room.key("box").get()).toEqual({ sealed: true });
  });

  it("is minted at the container for a claim on its items", async () => {
    const schema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "string", ifc: { writeAuthorizedBy: [WRITER] } },
        },
        note: { type: "string" },
      },
    } as JSONSchema;
    const doc = await create("items-claimed", schema, { note: "" });
    expect(declaredAt(entriesOf(doc), ["list"])).toMatchObject({ label: {} });

    refusedByClaim(
      (await asMember((tx) => {
        runtime.getCellFromLink(
          bare(doc, ["list"]),
          { type: "array" } as JSONSchema,
          tx,
        ).set(["forged"] as never);
      })).error,
      "the container through a bare schema",
    );
    refusedByClaim(
      (await asMember((tx) => {
        runtime.getCellFromLink(
          bare(doc, ["list", "0"]),
          { type: "string" } as JSONSchema,
          tx,
        ).set("forged" as never);
      })).error,
      "an item through a bare schema",
    );
    expect(doc.get().list).toBeUndefined();

    expect(
      (await asWriter((tx) => {
        doc.withTx(tx).key("list").set(["ok"] as never);
      })).error,
    ).toBeUndefined();
    expect(doc.get().list).toEqual(["ok"]);
  });

  it("is not minted under an ancestor's declared entry, which keeps labeling the position", async () => {
    const schema = {
      type: "object",
      ifc: { confidentiality: [cfcAtom.space(space)] },
      properties: {
        terms: { type: "object", ifc: { writeAuthorizedBy: [WRITER] } },
        note: { type: "string" },
      },
    } as JSONSchema;
    const doc = await create("under-root-label", schema, { note: "" });
    const entries = entriesOf(doc);
    expect(declaredAt(entries, [])?.label.confidentiality).toEqual([
      cfcAtom.space(space),
    ]);
    // No marker at `terms`: the root's entry already routes a write there,
    // so a marker would be a redundant, more specific entry in the declared
    // component. The two assertions after this one record what holds either
    // way — the position's label view carries the root's atom, and the
    // member is refused — and do not turn on the marker's absence.
    expect(declaredAt(entries, ["terms"])).toBeUndefined();
    const view = cfcLabelViewForResolvedCell(doc.key("terms"))?.entries
      .filter((entry) => entry.path.length === 0)
      .flatMap((entry) => entry.label.confidentiality ?? []);
    expect(view).toEqual([cfcAtom.space(space)]);

    refusedByClaim(
      (await asMember((tx) => {
        runtime.getCellFromLink(
          bare(doc, ["terms"]),
          { type: "object" } as JSONSchema,
          tx,
        ).set({ forged: true } as never);
      })).error,
      "the absent slot through a bare schema",
    );
    expect(doc.get().terms).toBeUndefined();
  });

  it("declares no policy, so the writer's first write is a creation under enforced monotonicity", async () => {
    await runtime.dispose();
    runtime = newRuntime({ cfcDeclaredMonotonicity: "enforce" });
    const schema = {
      type: "object",
      properties: {
        terms: {
          type: "object",
          ifc: {
            writeAuthorizedBy: [WRITER],
            addIntegrity: ["cfc-writer-claim-marker-attested"],
          },
        },
        note: { type: "string" },
      },
    } as JSONSchema;
    const doc = await create("enforced", schema, { note: "" });
    expect(declaredAt(entriesOf(doc), ["terms"])).toMatchObject({ label: {} });

    expect(
      (await asWriter((tx) => {
        doc.withTx(tx).key("terms").set({ question: "Where?" } as never);
      })).error,
    ).toBeUndefined();
    expect(doc.get().terms).toEqual({ question: "Where?" });
    expect(
      declaredAt(entriesOf(doc), ["terms"])?.label.integrity,
    ).toEqual(["cfc-writer-claim-marker-attested"]);

    refusedByClaim(
      (await asMember((tx) => {
        runtime.getCellFromLink(
          bare(doc, ["terms"]),
          { type: "object" } as JSONSchema,
          tx,
        ).set({ question: "forged" } as never);
      })).error,
      "the written slot through a bare schema",
    );
  });

  it("is minted at a union every branch of which carries the claim, the group chat's admin flag", async () => {
    // `ChatEveryoneAdminFlag` (cfc-group-chat-demo/trusted.tsx): a union of
    // a `true` and a `false` branch, both the toggle handler's, on an input
    // with no default. No value written there escapes the claim, so the
    // position is marked; a member's bare-link `set(true)` after the writer
    // set the admins would otherwise make every member an admin.
    const schema = {
      type: "object",
      properties: {
        admins: {
          type: "array",
          items: { type: "string" },
          ifc: { writeAuthorizedBy: [WRITER] },
        },
        everyoneIsAdmin: {
          anyOf: [{ $ref: "#/$defs/On" }, { $ref: "#/$defs/Off" }],
        },
      },
      $defs: {
        On: {
          type: "boolean",
          const: true,
          ifc: {
            writeAuthorizedBy: [WRITER],
            addIntegrity: ["cfc-writer-claim-marker-admin"],
          },
        },
        Off: {
          type: "boolean",
          const: false,
          ifc: { writeAuthorizedBy: [WRITER] },
        },
      },
    } as JSONSchema;
    const registry = await create("admin-registry", schema, {});
    expect(declaredAt(entriesOf(registry), ["everyoneIsAdmin"])).toMatchObject(
      { label: {} },
    );
    expect(
      (await asWriter((tx) => {
        registry.withTx(tx).key("admins").set(["alice"] as never);
      })).error,
    ).toBeUndefined();

    refusedByClaim(
      (await asMember((tx) => {
        runtime.getCellFromLink(
          bare(registry, ["everyoneIsAdmin"]),
          undefined,
          tx,
        )
          .set(true as never);
      })).error,
      "the flag through a bare link",
    );
    expect(registry.get().everyoneIsAdmin).toBeUndefined();

    expect(
      (await asWriter((tx) => {
        registry.withTx(tx).key("everyoneIsAdmin").set(false as never);
      })).error,
    ).toBeUndefined();
    expect(registry.get().everyoneIsAdmin).toBe(false);
    refusedByClaim(
      (await asMember((tx) => {
        runtime.getCellFromLink(
          bare(registry, ["everyoneIsAdmin"]),
          undefined,
          tx,
        )
          .set(true as never);
      })).error,
      "the written flag through a bare link",
    );
    expect(registry.get().everyoneIsAdmin).toBe(false);
  });

  it("is not minted at a union with an unclaimed branch", async () => {
    // Which branch a position takes is the value's to decide; a position
    // holding nothing is on no branch (cfc-ui-contract's mixed arrays).
    const schema = {
      type: "object",
      properties: {
        admins: {
          type: "array",
          items: { type: "string" },
          ifc: { writeAuthorizedBy: [WRITER] },
        },
        flag: {
          anyOf: [
            {
              type: "boolean",
              const: true,
              ifc: { writeAuthorizedBy: [WRITER] },
            },
            { type: "boolean", const: false },
          ],
        },
      },
    } as JSONSchema;
    const doc = await create("one-branch-claimed", schema, {});
    const entries = entriesOf(doc);
    expect(declaredAt(entries, ["admins"])).toMatchObject({ label: {} });
    expect(declaredAt(entries, ["flag"])).toBeUndefined();
  });

  it("records a write at an item of an item as the outermost array", async () => {
    const schema = {
      type: "object",
      properties: {
        grid: {
          type: "array",
          items: { type: "array", items: { type: "number" } },
          ifc: { writeAuthorizedBy: [WRITER] },
        },
      },
    } as JSONSchema;
    const doc = await create("grid", schema, {});
    expect(
      (await asWriter((tx) => {
        doc.withTx(tx).key("grid").set([[1]] as never);
      })).error,
    ).toBeUndefined();
    // The writer's own write two indexes down commits.
    expect(
      (await asWriter((tx) => {
        (doc.withTx(tx).key("grid") as Cell<number[][]>).key(0).key(0).set(2);
      })).error,
    ).toBeUndefined();
    expect(doc.get().grid).toEqual([[2]]);
    refusedByClaim(
      (await asMember((tx) => {
        runtime.getCellFromLink(
          bare(doc, ["grid", "0", "0"]),
          { type: "number" } as JSONSchema,
          tx,
        ).set(3 as never);
      })).error,
      "an item of an item through a bare schema",
    );
    expect(doc.get().grid).toEqual([[2]]);
  });

  it("refuses an item write on an absent claimed container, and a bare-link item write, by the claim", async () => {
    const schema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "string" },
          ifc: { writeAuthorizedBy: [WRITER] },
        },
        note: { type: "string" },
      },
    } as JSONSchema;
    const doc = await create("container-claimed", schema, { note: "" });

    // The container holds nothing: its first item write is still an item
    // write, answered by the claim on the container.
    refusedByClaim(
      (await asMember((tx) => {
        runtime.getCellFromLink(
          bare(doc, ["list", "0"]),
          { type: "string" } as JSONSchema,
          tx,
        ).set("forged" as never);
      })).error,
      "an item of the absent container",
    );
    expect(doc.get().list).toBeUndefined();

    expect(
      (await asWriter((tx) => {
        doc.withTx(tx).key("list").set(["ok"] as never);
      })).error,
    ).toBeUndefined();

    // A writer holding no schema at all for the item answers to the stored
    // claim, and not to a type clash of an envelope spelled at the index.
    refusedByClaim(
      (await asMember((tx) => {
        runtime.getCellFromLink(bare(doc, ["list", "0"]), undefined, tx).set(
          "forged" as never,
        );
      })).error,
      "an item through a bare link",
    );
    expect(doc.get().list).toEqual(["ok"]);
  });
});

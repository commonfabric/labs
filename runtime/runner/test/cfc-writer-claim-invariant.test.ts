import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimePresets } from "../src/runtime-presets.ts";
import { setCfcImplementationIdentity } from "../src/cfc/trust-authority.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// The no-weaker-than-base table for writer claims on positions that hold
// nothing yet, and on links. Each row is one write — by the named writer, a
// second writer, or a member's own code — and its outcome: `committed`, or
// `refused` with the class of reason. The outcome asserted is this head's;
// the base's (labs `763ff5afa1`) is recorded beside it, from the same file
// run on the base's sources. Three kinds of row:
//
// - base refused, head refuses: the bar this file holds — nothing the base
//   caught is let through;
// - base committed, head refuses: the fixes — a member's write into an
//   absent claimed slot, an item of a claimed container, a link slot, or a
//   branch of an every-branch union;
// - base and head commit alike, by a member: pre-existing gaps the PR body
//   lists as follow-ups (a value on no branch of an every-branch union, a
//   claim inside each item of a defaultless container, wildcard positions).
//
// Every write the named writer makes that committed on the base commits
// here; one that the base refused and this head admits is a fix (the seal's
// second link, an item of an item).

const signer = await Identity.fromPassphrase("cfc-writer-claim-invariant");
const space = signer.did();
const W = "cfc-writer-claim-invariant-writer";
const WB = "cfc-writer-claim-invariant-second-writer";

type Doc = Record<string, unknown>;
type Outcome = "committed" | "refused: claim" | `refused: ${string}`;

const rows: string[] = [];

describe("writer claims: no weaker than the base", () => {
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

  const as = (
    builtinId: string,
    write: (tx: IExtendedStorageTransaction) => void,
  ) =>
    runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, { kind: "builtin", builtinId });
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

  const bare = (doc: Cell<unknown>, path: string[]) => {
    const { schema: _schema, ...link } = doc.getAsNormalizedFullLink();
    return { ...link, path: [...link.path, ...path] };
  };

  const outcomeOf = (result: { error?: unknown }): Outcome => {
    if (result.error === undefined) return "committed";
    const error = result.error as { reasons?: unknown; message?: string };
    const reason = Array.isArray(error.reasons)
      ? String(error.reasons[0])
      : String(error.message ?? error);
    return reason.startsWith("writeAuthorizedBy")
      ? "refused: claim"
      : `refused: ${reason.slice(0, 60)}`;
  };

  /** Records a row and asserts this head's outcome class. */
  const row = (
    name: string,
    actor: "writer" | "second writer" | "member",
    outcome: Outcome,
    expected: "committed" | "refused",
  ) => {
    rows.push(`| ${name} | ${actor} | ${outcome} |`);
    console.log(`INVARIANT | ${name} | ${actor} | ${outcome}`);
    // `CFC_INVARIANT_RECORD=1` records every row without asserting, which
    // is how the base column is taken: the same file on the base's sources.
    if (Deno.env.get("CFC_INVARIANT_RECORD") === "1") return;
    if (expected === "committed") expect(outcome, name).toBe("committed");
    else {expect(outcome.startsWith("refused"), `${name}: ${outcome}`).toBe(
        true,
      );}
  };

  const bareSet =
    (doc: Cell<unknown>, path: string[], value: unknown) =>
    (tx: IExtendedStorageTransaction) => {
      runtime.getCellFromLink(bare(doc, path), undefined, tx).set(
        value as never,
      );
    };

  it("absent claimed slots (A, C)", async () => {
    const schema = {
      type: "object",
      properties: {
        terms: { type: "object", ifc: { writeAuthorizedBy: [W] } },
        frozen: { type: "string", ifc: { writeAuthorizedBy: [W] } },
        note: { type: "string" },
      },
    } as JSONSchema;
    // No claimed input has a value (A).
    const a = await create("inv-a", schema, { note: "" });
    row(
      "A: member sets absent claimed slot",
      "member",
      outcomeOf(await asMember(bareSet(a, ["terms"], { forged: true }))),
      "refused",
    );
    row(
      "A: member sets a field beneath the absent slot",
      "member",
      outcomeOf(await asMember(bareSet(a, ["terms", "extra"], 1))),
      "refused",
    );
    row(
      "A: writer's first write",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          a.withTx(tx).key("terms").set({ question: "Where?" } as never);
        }),
      ),
      "committed",
    );
    row(
      "A: member rewrites the written slot",
      "member",
      outcomeOf(await asMember(bareSet(a, ["terms"], { forged: true }))),
      "refused",
    );
    row(
      "A: member clears the written slot",
      "member",
      outcomeOf(await asMember(bareSet(a, ["terms"], null))),
      "refused",
    );
    // A sibling claimed input holds a value, this one does not (C).
    const c = await create("inv-c", schema, { note: "" });
    expect(
      (await as(W, (tx) => {
        c.withTx(tx).key("frozen").set("" as never);
      })).error,
    ).toBeUndefined();
    row(
      "C: member sets absent slot beside a written claimed sibling",
      "member",
      outcomeOf(await asMember(bareSet(c, ["terms"], { forged: true }))),
      "refused",
    );
  });

  it("a claimed slot holding a link (D)", async () => {
    const boxSchema = {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { instance: { type: "string" } },
        required: ["instance"],
      },
      ifc: { confidentiality: [cfcAtom.space(space)] },
    } as JSONSchema;
    const roomSchema = {
      type: "object",
      properties: {
        box: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              instance: { type: "string" },
              extra: { type: "string" },
            },
            required: ["instance", "extra"],
          },
          ifc: { writeAuthorizedBy: [W] },
        },
        note: { type: "string" },
      },
    } as JSONSchema;
    const room = await create("inv-d-room", roomSchema, { note: "" });
    const box = runtime.getCell<Doc>(space, "inv-d-box", boxSchema);
    const linkTo = (cell: Cell<unknown>, tx: IExtendedStorageTransaction) =>
      runtime.getCellFromLink(
        { ...cell.getAsNormalizedFullLink(), schema: undefined },
        undefined,
        tx,
      );
    row(
      "D: writer's first link into the slot",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          box.withTx(tx).set({});
          room.withTx(tx).key("box").set(linkTo(box, tx) as never);
        }),
      ),
      "committed",
    );
    row(
      "D: writer's second seal (entry + same link)",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          box.withTx(tx).key("e1").set({ instance: "i1" } as never);
          room.withTx(tx).key("box").set(linkTo(box, tx) as never);
        }),
      ),
      "committed",
    );
    const other = runtime.getCell<Doc>(space, "inv-d-other", boxSchema);
    row(
      "D: member repoints the link slot",
      "member",
      outcomeOf(
        await asMember((tx) => {
          other.withTx(tx).set({});
          runtime.getCellFromLink(
            bare(room, ["box"]),
            { type: "object" } as JSONSchema,
            tx,
          )
            .set(linkTo(other, tx) as never);
        }),
      ),
      "refused",
    );
    row(
      "D: member clears the link slot to {}",
      "member",
      outcomeOf(await asMember(bareSet(room, ["box"], {}))),
      "refused",
    );
  });

  it("a claim on a container's items, and on the container", async () => {
    const itemsClaimed = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "string", ifc: { writeAuthorizedBy: [W] } },
        },
        note: { type: "string" },
      },
    } as JSONSchema;
    const l = await create("inv-items", itemsClaimed, { note: "" });
    row(
      "items claim: member sets the absent container",
      "member",
      outcomeOf(
        await asMember((tx) => {
          runtime.getCellFromLink(
            bare(l, ["list"]),
            { type: "array" } as JSONSchema,
            tx,
          )
            .set(["forged"] as never);
        }),
      ),
      "refused",
    );
    row(
      "items claim: member sets an item of the absent container",
      "member",
      outcomeOf(await asMember(bareSet(l, ["list", "0"], "forged"))),
      "refused",
    );
    row(
      "items claim: writer's first write",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          l.withTx(tx).key("list").set(["ok"] as never);
        }),
      ),
      "committed",
    );

    const containerClaimed = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "string" },
          ifc: { writeAuthorizedBy: [W] },
        },
        grid: {
          type: "array",
          items: { type: "array", items: { type: "number" } },
          ifc: { writeAuthorizedBy: [W] },
        },
        note: { type: "string" },
      },
    } as JSONSchema;
    const k = await create("inv-container", containerClaimed, { note: "" });
    row(
      "container claim: member sets an item of the absent container",
      "member",
      outcomeOf(await asMember(bareSet(k, ["list", "0"], "forged"))),
      "refused",
    );
    row(
      "container claim: writer's first write",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          k.withTx(tx).key("list").set(["ok"] as never);
          k.withTx(tx).key("grid").set([[1]] as never);
        }),
      ),
      "committed",
    );
    row(
      "container claim: member sets an item through a bare link",
      "member",
      outcomeOf(await asMember(bareSet(k, ["list", "0"], "forged"))),
      "refused",
    );
    row(
      "container claim: writer sets an item of an item",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          (k.withTx(tx).key("grid") as Cell<number[][]>).key(0).key(0).set(2);
        }),
      ),
      "committed",
    );
    row(
      "container claim: member sets an item of an item",
      "member",
      outcomeOf(await asMember(bareSet(k, ["grid", "0", "0"], 3))),
      "refused",
    );
  });

  it("an every-branch union: the group chat's admin flag", async () => {
    const schema = {
      type: "object",
      properties: {
        admins: {
          type: "array",
          items: { type: "string" },
          ifc: { writeAuthorizedBy: [W] },
        },
        everyoneIsAdmin: {
          anyOf: [{ $ref: "#/$defs/On" }, { $ref: "#/$defs/Off" }],
        },
      },
      $defs: {
        On: { type: "boolean", const: true, ifc: { writeAuthorizedBy: [W] } },
        Off: { type: "boolean", const: false, ifc: { writeAuthorizedBy: [W] } },
      },
    } as JSONSchema;
    const r = await create("inv-union", schema, {});
    row(
      "union: writer sets admins",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          r.withTx(tx).key("admins").set(["alice"] as never);
        }),
      ),
      "committed",
    );
    row(
      "union: member sets true (on a branch)",
      "member",
      outcomeOf(await asMember(bareSet(r, ["everyoneIsAdmin"], true))),
      "refused",
    );
    row(
      "union: writer sets false",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          r.withTx(tx).key("everyoneIsAdmin").set(false as never);
        }),
      ),
      "committed",
    );
    row(
      "union: member sets true over false",
      "member",
      outcomeOf(await asMember(bareSet(r, ["everyoneIsAdmin"], true))),
      "refused",
    );
    // Off-branch values: a branch's claim applies to the values it admits,
    // so none applies to `null`. Pre-existing; a follow-up, not this PR's.
    for (const off of [null, 0, "false"]) {
      const fresh = await create(`inv-union-off-${String(off)}`, schema, {});
      await as(W, (tx) => {
        fresh.withTx(tx).key("everyoneIsAdmin").set(false as never);
      });
      row(
        `union (follow-up): member sets ${JSON.stringify(off)} off-branch`,
        "member",
        outcomeOf(await asMember(bareSet(fresh, ["everyoneIsAdmin"], off))),
        "committed",
      );
    }
  });

  it("the reviewer's unions: per-branch writers, allOf, a direct claim", async () => {
    // T1: different writers per branch.
    const t1 = await create("inv-t1", {
      type: "object",
      properties: {
        note: { type: "string" },
        flag: {
          anyOf: [
            { const: true, ifc: { writeAuthorizedBy: [W] } },
            { const: false, ifc: { writeAuthorizedBy: [WB] } },
          ],
        },
      },
    } as JSONSchema, { note: "" });
    row(
      "T1: writer A sets true",
      "writer",
      outcomeOf(await as(W, bareSet(t1, ["flag"], true))),
      "committed",
    );
    row(
      "T1: member sets false (B's branch)",
      "member",
      outcomeOf(await asMember(bareSet(t1, ["flag"], false))),
      "refused",
    );
    row(
      "T1 (follow-up): writer A sets null off-branch",
      "writer",
      outcomeOf(await as(W, bareSet(t1, ["flag"], null))),
      "committed",
    );

    // T3: a second union at the same path through allOf.
    const t3 = await create("inv-t3", {
      type: "object",
      properties: {
        note: { type: "string" },
        flag: {
          allOf: [
            {
              anyOf: [
                { const: true, ifc: { writeAuthorizedBy: [W] } },
                { const: false, ifc: { writeAuthorizedBy: [W] } },
              ],
            },
            {
              anyOf: [
                {
                  type: "null",
                  ifc: { confidentiality: [cfcAtom.space(space)] },
                },
                { type: "boolean" },
              ],
            },
          ],
        },
      },
    } as JSONSchema, { note: "" });
    row(
      "T3: writer sets false",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          t3.withTx(tx).key("flag").set(false as never);
        }),
      ),
      "committed",
    );
    row(
      "T3: member sets true",
      "member",
      outcomeOf(await asMember(bareSet(t3, ["flag"], true))),
      "refused",
    );
    row(
      "T3 (follow-up): member sets null",
      "member",
      outcomeOf(await asMember(bareSet(t3, ["flag"], null))),
      "committed",
    );

    // T4: a direct claim beside a partially claimed union: null is a valid
    // value of the position, and the direct claim is A's.
    const t4 = await create("inv-t4", {
      type: "object",
      properties: {
        note: { type: "string" },
        x: {
          ifc: { writeAuthorizedBy: [W] },
          anyOf: [
            { type: "object", ifc: { writeAuthorizedBy: [WB] } },
            { type: "null" },
          ],
        },
      },
    } as JSONSchema, { note: "" });
    row(
      "T4: writer A sets null (valid, unclaimed branch)",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          t4.withTx(tx).key("x").set(null as never);
        }),
      ),
      "committed",
    );
    row(
      "T4: writer A sets null through a bare link",
      "writer",
      outcomeOf(await as(W, bareSet(t4, ["x"], null))),
      "committed",
    );
    row(
      "T4: member sets null",
      "member",
      outcomeOf(await asMember(bareSet(t4, ["x"], null))),
      "refused",
    );
  });

  it("claims inside each item of a container (T2, T5): follow-ups", async () => {
    const flag = {
      anyOf: [
        { const: true, ifc: { writeAuthorizedBy: [W] } },
        { const: false, ifc: { writeAuthorizedBy: [W] } },
      ],
    };
    const t2 = await create("inv-t2", {
      type: "object",
      properties: {
        note: { type: "string" },
        members: {
          type: "array",
          items: { type: "object", properties: { isAdmin: flag } },
        },
      },
    } as JSONSchema, { note: "" });
    row(
      "T2: writer sets [{isAdmin:false}]",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          t2.withTx(tx).key("members").set([{ isAdmin: false }] as never);
        }),
      ),
      "committed",
    );
    row(
      "T2 (follow-up): member sets members/0 = {isAdmin:true}",
      "member",
      outcomeOf(
        await asMember(bareSet(t2, ["members", "0"], { isAdmin: true })),
      ),
      "committed",
    );
    row(
      "T2 (follow-up): member appends {isAdmin:true}",
      "member",
      outcomeOf(
        await asMember(bareSet(t2, ["members", "1"], { isAdmin: true })),
      ),
      "committed",
    );

    const t5schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string", ifc: { writeAuthorizedBy: [W] } },
            },
          },
        },
        note: { type: "string" },
      },
    } as JSONSchema;
    const t5 = await create("inv-t5", t5schema, { note: "" });
    row(
      "T5 (follow-up): member sets items=[{claim:forged}] on a defaultless container",
      "member",
      outcomeOf(await asMember(bareSet(t5, ["items"], [{ claim: "forged" }]))),
      "committed",
    );
    const t5d = await create("inv-t5d", t5schema, { note: "", items: [] });
    // No item exists, so no entry at `items/*/claim` is minted and the
    // container is not marked: the same follow-up as the defaultless one.
    row(
      "T5 (follow-up): member sets items=[{claim:forged}] on an empty container",
      "member",
      outcomeOf(await asMember(bareSet(t5d, ["items"], [{ claim: "forged" }]))),
      "committed",
    );
    row(
      "T5: writer sets items=[{claim:ok}]",
      "writer",
      outcomeOf(
        await as(W, (tx) => {
          t5d.withTx(tx).key("items").set([{ claim: "ok" }] as never);
        }),
      ),
      "committed",
    );
    row(
      "T5: member rewrites items/0/claim",
      "member",
      outcomeOf(
        await asMember(bareSet(t5d, ["items", "0", "claim"], "forged")),
      ),
      "refused",
    );
  });

  it("prints the table", () => {
    console.log(
      ["| case | actor | outcome on this head |", "|---|---|---|", ...rows]
        .join("\n"),
    );
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// SCOPE: this guards the verified-binding contract only — an inSpace child's
// owner-protected list, written by a NON-exported mode-bound handler from a
// fresh session, must retain its binding authority through the warm/cached
// reload. Both sessions here share ONE compiled PROGRAM, so they share one
// `moduleIdentity`, so this does NOT reproduce a two-compile-context
// moduleIdentity *merge-conflict* ("writeAuthorizedBy must remain stable"),
// which needs a faithful two-context harness.
const signer = await Identity.fromPassphrase("inspace-child-owner-write");
const spaceA = signer.did(); // "home" — runs the parent, creates the child
const spaceB = (await Identity.fromPassphrase("owner write child B")).did();

// Two-manager shape (same as inspace-child-owner-seed.test.ts): each session
// has its OWN per-space replicas, loopback-connected to one shared in-process
// memory server — the real browser/CLI session split. A single emulate
// manager's shared replicas would mask the warm/cached re-load on the reader
// (where the warm-load writer identity is decided).

// The profile-create flow in miniature, exercising the OWNER-PROTECTED WRITE
// path. The child pattern owns an `elements` list that is written
// ONLY by `mutate` — a NON-exported, mode-bound handler (mirrors
// profile-home.tsx's `mutateElements`: a single handler instance per mode,
// never exported). The list is exposed for mutation only through the exported
// `add` stream (`mutate({ items, mode: "add" })`).
//
// Standalone (single-context) the write commits fine. The real flow creates
// the child via `child.inSpace(spaceB)(...)` from the parent, and a FRESH
// session loads the child from its own space via the warm/cached module path.
// The assertion below pins the durable security contract: the non-exported
// handler's content-addressed provenance and `__cfBindVerifiedBinding` authority
// survive that source-free reload. Debug source metadata is deliberately
// irrelevant to the decision.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import {",
        "  Cell,",
        "  Cfc,",
        "  handler,",
        "  lift,",
        "  pattern,",
        "  RepresentsCurrentUser,",
        "  Stream,",
        "  Writable,",
        "  WriteAuthorizedBy,",
        "} from 'commonfabric';",
        "",
        "type CurrentPrincipal = { readonly __ctCurrentPrincipal: true };",
        "",
        "type OwnerProtected<T, Binding> = RepresentsCurrentUser<",
        "  Cfc<",
        "    WriteAuthorizedBy<T, Binding>,",
        "    { ownerPrincipal: CurrentPrincipal }",
        "  >",
        ">;",
        "",
        "type MutateEvent = { item?: string };",
        "",
        "// THE single authorized writer for the owner-protected `items` list:",
        "// non-exported, mode-bound (mirrors profile-home.tsx's mutateElements).",
        "const mutate = handler<",
        "  MutateEvent,",
        "  { items: Writable<string[]>; mode: 'add' | 'remove' }",
        ">((event, state) => {",
        "  if (state.mode === 'add') {",
        "    if (event.item === undefined) return;",
        "    state.items.push(event.item);",
        "    return;",
        "  }",
        "  if (event.item === undefined) return;",
        "  state.items.set(state.items.get().filter((i) => i !== event.item));",
        "});",
        "",
        "interface ChildOutput {",
        "  items: OwnerProtected<string[], typeof mutate>;",
        "  add: Stream<MutateEvent>;",
        "  remove: Stream<MutateEvent>;",
        "}",
        "",
        "const createItems = lift<",
        "  { seed?: string },",
        "  OwnerProtected<Cell<OwnerProtected<string[], typeof mutate>>, typeof mutate>",
        ">(({ seed }) =>",
        "  new Writable<OwnerProtected<string[], typeof mutate>>(seed ? [seed] : []).for('items')",
        ");",
        "",
        "export const child = pattern<{ seed?: string }, ChildOutput>(",
        "  ({ seed }) => {",
        "    const items = createItems({ seed });",
        "    return {",
        "      items,",
        "      add: mutate({ items, mode: 'add' }),",
        "      remove: mutate({ items, mode: 'remove' }),",
        "    };",
        "  },",
        ");",
        "",
        "const create = handler<",
        "  { seed?: string },",
        "  { children: Writable<ChildOutput[]> }",
        ">((event, { children }) => {",
        `  children.push(child.inSpace("${spaceB}")({`,
        "    seed: event.seed,",
        "  }) as ChildOutput);",
        "});",
        "",
        "export default pattern(() => {",
        "  const children = new Writable<ChildOutput[]>([]).for('children');",
        "  return { children, create: create({ children }) };",
        "});",
      ].join("\n"),
    },
  ],
};

const RESULT_CAUSE = "inspace child owner write parent";

const childLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

const itemListSchema = {
  type: "array",
  items: { type: "string" },
  // deno-lint-ignore no-explicit-any
} as any;

describe("inSpace child owner-protected write (profile elements)", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await managerA?.close();
    await managerB?.close();
    await server?.close();
  });

  it("a fresh session adds an item to the owner-protected list", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
    const schedulerErrors: Error[] = [];
    rt1.scheduler.onError((error) => schedulerErrors.push(error));
    rt2.scheduler.onError((error) => schedulerErrors.push(error));
    try {
      // Session 1: run the parent in space A; the handler creates the child in
      // space B with the owner-protected `items` list (profile creation).
      const tx1 = rt1.edit();
      const parent = await rt1.patternManager.compilePattern(PROGRAM, {
        space: spaceA,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        spaceA,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, parent as any, {}, resultCell1);
      // A manual test tx must prepare (the runtime's own commit paths do) or a
      // CFC-relevant tx is rejected wholesale at commit.
      rt1.prepareTxForCommit(tx1);
      const commit1 = await tx1.commit();
      expect(commit1.error).toBeUndefined();
      await r1.pull();

      // Fresh tx for the create event: the ifc-carrying schema makes send()
      // read CFC metadata through the cell's tx, and tx1 is already done.
      const tx2 = rt1.edit();
      r1.withTx(tx2).key("create").send({ seed: "first" });
      const commit2 = await tx2.commit();
      expect(commit2.error).toBeUndefined();
      await r1.pull();
      await rt1.idle();

      await r1.pull();
      const links = r1.key("children").asSchema(childLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(links.length).toBe(1);
      const childLink = links[0].getAsNormalizedFullLink();
      expect(childLink.space).toBe(spaceB);
      expect(links[0].key("items").asSchema(itemListSchema).get()).toEqual([
        "first",
      ]);
      expect(schedulerErrors).toEqual([]);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      await rt1.idle();
      await rt1.storageManager.synced();

      // Session 2 (own replicas, warm/cached child load): load the child from
      // its own space and start it (the shell's piece view always starts).
      const childCell = rt2.getCellFromLink(childLink);
      await childCell.sync();
      const started = await rt2.start(childCell);
      expect(started).toBe(true);
      await rt2.idle();

      // Send the owner-protected WRITE. A warm-load writer identity downgraded
      // to `unsupported` would have the commit rejected with "writeAuthorizedBy
      // requires a trusted verified binding identity at /".
      const writeTx = rt2.edit();
      childCell.withTx(writeTx).key("add").send({ item: "second" });
      // A manual test tx prepares the way the runtime's own commit paths do:
      // an enforcing rung refuses a relevant transaction that arrives
      // unprepared.
      rt2.prepareTxForCommit(writeTx);
      const writeCommit = await writeTx.commit();
      expect(writeCommit.error).toBeUndefined();
      await childCell.pull();
      await rt2.idle();
      await childCell.pull();

      const itemsCell = childCell.key("items").asSchema(itemListSchema);
      await itemsCell.sync();
      await itemsCell.pull();
      const items = itemsCell.get() as string[];
      expect([...items].sort()).toEqual(["first", "second"]);
      expect(schedulerErrors).toEqual([]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

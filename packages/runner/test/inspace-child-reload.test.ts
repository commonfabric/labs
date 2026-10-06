import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("inspace-child-reload");
const spaceA = signer.did();
const spaceB = (await Identity.fromPassphrase("inspace child target B")).did();
const spaceC = (await Identity.fromPassphrase("inspace child target C")).did();

// A handler that materializes a child piece in ANOTHER space via
// `Child.inSpace(...)({...})` (the multi-profile flow: profile-create.tsx pushes
// `ProfileHome.inSpace(name)({initialName})` onto the home `profiles` list) must
// leave the child independently loadable FROM ITS OWN SPACE. A fresh runtime
// navigating to the child piece (the shell's piece view) loads pattern artifacts
// from `resultCell.space` — the child space — so both the pattern meta
// (program) and the content-addressed source/compiled closures must be
// persisted there, not only in the space the parent bundle compiled into.
// Without them the load fails with "Pattern <id> has no stored source" →
// "Failed to load piece", and profiles are uneditable.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { handler, pattern, Writable } from 'commonfabric';",
        "",
        "export const child = pattern<{ label: string }>(({ label }) => ({",
        "  label,",
        "}));",
        "",
        "type ChildOutput = { label: string };",
        "",
        "const create = handler<",
        "  { label?: string },",
        "  { items: Writable<ChildOutput[]> }",
        ">((event, { items }) => {",
        `  items.push(child.inSpace("${spaceB}")({`,
        "    label: event.label ?? 'hi',",
        "  }) as ChildOutput);",
        "});",
        "",
        "export default pattern(() => {",
        "  const items = new Writable<ChildOutput[]>([]).for('items');",
        "  return { items, create: create({ items }) };",
        "});",
      ].join("\n"),
    },
  ],
};

const RESULT_CAUSE = "inspace child reload parent";

const childLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

describe("inSpace child piece reload from its own space", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("a fresh runtime can start the child from space B", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      // Session 1: run the parent in space A, create the child in space B via
      // the handler (the profile-create flow).
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
      await tx1.commit().settled;
      await r1.pull();

      r1.key("create").send({ label: "hi" });
      await r1.pull();
      await rt1.idle();
      // The cross-space child creation rides server->client delivery turns;
      // drain them before reading the freshly pushed link.
      await clock.settle();
      await r1.pull();

      // The child materialized in space B (link identity, no deep resolve).
      const links = r1.key("items").asSchema(childLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(links.length).toBe(1);
      const childLink = links[0].getAsNormalizedFullLink();
      expect(childLink.space).toBe(spaceB);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Session 2: a fresh runtime loads the child piece from ITS OWN space —
      // the shell's navigate-to-piece path, which must not reject with
      // "Pattern <id> has no stored source".
      const childCell = rt2.getCellFromLink(childLink);
      await childCell.sync();
      const started = await rt2.start(childCell);
      expect(started).toBe(true);

      await childCell.pull();
      const value = childCell.getAsQueryResult() as { label: string };
      expect(value.label).toBe("hi");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a fresh runtime can start a build-time inSpace child", async () => {
    // The build-time variant: the child node sits in the PARENT's graph (not a
    // handler frame), so the cross-space transition is visible to
    // `instantiatePatternNode` (resultCell.space !== resultCellLink.space) —
    // the other replication hook.

    const STATIC_PROGRAM: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "",
            "export const child = pattern<{ label: string }>(({ label }) => ({",
            "  label,",
            "}));",
            "",
            "export default pattern(() => ({",
            `  kid: child.inSpace("${spaceC}")({ label: 'static-hi' }),`,
            "}));",
          ].join("\n"),
        },
      ],
    };

    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      const tx1 = rt1.edit();
      const parent = await rt1.patternManager.compilePattern(STATIC_PROGRAM, {
        space: spaceA,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        spaceA,
        "inspace static child parent",
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, parent as any, {}, resultCell1);
      await tx1.commit().settled;
      await r1.pull();
      await rt1.idle();

      const kidCell = r1.key("kid").asSchema(
        // deno-lint-ignore no-explicit-any
        { type: "unknown", asCell: ["cell"] } as any,
        // deno-lint-ignore no-explicit-any
      ).get() as any;
      const kidLink = kidCell.getAsNormalizedFullLink();
      expect(kidLink.space).toBe(spaceC);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      const childCell = rt2.getCellFromLink(kidLink);
      await childCell.sync();
      const started = await rt2.start(childCell);
      expect(started).toBe(true);

      await childCell.pull();
      const value = childCell.getAsQueryResult() as { label: string };
      expect(value.label).toBe("static-hi");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

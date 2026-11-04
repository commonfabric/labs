import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("scoped input write");

/**
 * A pattern with a session-scoped input beside an ordinary one. The scoped
 * input is stored as a link, which is what the write path has to tolerate when
 * it validates the whole arguments object.
 */
const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, type Default, NAME, pattern, type PerSession,",
      "  type Writable } from 'commonfabric';",
      "interface View { openKey?: string }",
      "interface Args {",
      "  labels?: Writable<string[] | Default<never[]>>;",
      "  view?: PerSession<Writable<View | Default<Record<string, never>>>>;",
      "}",
      "export default pattern<Args, { count: number; open: string }>(",
      "  ({ labels, view }) => ({",
      "    [NAME]: 'Scoped input write',",
      "    count: computed((): number => (labels.get() ?? []).length),",
      "    // Reading the scoped input is what mints its link, and the link",
      "    // is what the write path then has to tolerate.",
      "    open: computed((): string => (view.get() ?? {}).openKey ?? ''),",
      "  }),",
      ");",
      "",
    ].join("\n"),
  }],
};

describe("scoped input write", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("writes one input on a piece that also has a session-scoped one", async () => {
    // The staged root is read without a schema, so the scoped input arrives as
    // its stored link rather than as a Cell. A `cf` client whose session is
    // not the one that minted that link is still refused here, naming `view`
    // for a write that never touched it; this guards the same-session case
    // only. See stage 4a of docs/plans/person-inbox-interaction-cost.md.

    const piece = await pieces.create(program, { input: {} });
    await runtime.idle();

    await piece.input.set(["first", "second"], ["labels"]);
    await runtime.idle();

    expect(await piece.input.get(["labels"])).toEqual(["first", "second"]);
  });

  it("writes the scoped input itself", async () => {
    const piece = await pieces.create(program, { input: {} });
    await runtime.idle();

    await piece.input.set({ openKey: "abc" }, ["view"]);
    await runtime.idle();

    expect(await piece.input.get(["view"])).toEqual({ openKey: "abc" });
  });
});

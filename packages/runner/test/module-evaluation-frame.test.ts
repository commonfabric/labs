import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("module evaluation frame");
const home = signer.did();
const elsewhere =
  (await Identity.fromPassphrase("module evaluation frame elsewhere"))
    .did();

// A pattern whose body mints an internal cell and binds it into its UI, the
// shape of home.tsx's `defaultAppUrl` and `activeTab`.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { NAME, UI, pattern, Writable } from 'commonfabric';",
      "export default pattern(() => {",
      "  const draft = new Writable('').for('draft');",
      "  return {",
      "    [NAME]: 'draft holder',",
      "    [UI]: <cf-input $value={draft} />,",
      "  };",
      "});",
    ].join("\n"),
  }],
};

describe("module evaluation frame", () => {
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
    await runtime.dispose();
    await storageManager.close();
  });

  it("does not take the space of an action suspended beneath it", async () => {
    // An awaiting handler keeps its frame on the stack, and a module can be
    // evaluated while it waits. Cells the pattern body mints belong to each
    // instance, so they must not be bound to the waiting handler's space.
    const suspendedTx = runtime.edit();
    const suspended = pushFrame({
      runtime,
      space: elsewhere,
      tx: suspendedTx,
      cause: "suspended handler",
      inHandler: true,
    });
    let pattern: Pattern;
    try {
      const { main } = await runtime.harness.compileAndEvaluateModules(
        PROGRAM,
      );
      pattern = (main as { default: Pattern }).default;
    } finally {
      popFrame(suspended);
      suspendedTx.abort();
    }

    const result = runtime.getCell(
      home,
      "module evaluation frame result",
    );
    await runtime.runSynced(result, pattern, {});
    const rendered = result.getRaw() as {
      $UI: { props: { $value: unknown } };
    };
    const bound = parseLink(rendered.$UI.props.$value, result);
    expect(bound?.space).toBe(home);
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "bound list pattern handler stream lifecycle",
);
const space = signer.did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { action, computed, pattern, Writable } from 'commonfabric';",
      "export default pattern(() => {",
      "  const canManage = new Writable(false);",
      "  const admins = new Writable<string[]>([]);",
      "  const enable = action(() => canManage.set(true));",
      "  const toggle = action<{ name: string }>(({ name }) => {",
      "    admins.set([...admins.get(), name]);",
      "  });",
      "  const rows = computed(() => [{",
      "    name: 'Alice',",
      "    canManage: canManage.get(),",
      "    isAdmin: admins.get().includes('Alice'),",
      "  }]);",
      "  return {",
      "    admins,",
      "    canManage,",
      "    enable,",
      "    rows: rows.map((row) => ({",
      "      name: row.name,",
      "      canManage: row.canManage,",
      "      isAdmin: row.isAdmin,",
      "      toggle: action(() => toggle.send({ name: row.name })),",
      "    })),",
      "  };",
      "});",
    ].join("\n"),
  }],
};

async function waitFor<T>(
  runtime: Runtime,
  read: () => T,
  matches: (value: T) => boolean,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await runtime.idle();
    const value = read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(read())}`);
}

describe("bound list pattern handler stream lifecycle", () => {
  it("keeps a captured parent handler reachable after a row input update", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
      });
      const tx = runtime.edit();
      const root = runtime.getCell<Record<string, unknown>>(
        space,
        "bound-list-handler-stream-result",
        compiled.resultSchema,
        tx,
      );
      const result = runtime.run(tx, compiled, {}, root);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();

      await result.pull();
      const cancelSink = result.sink(() => {});
      expect(result.key("rows").key(0).key("canManage").get()).toBe(false);

      result.key("enable").send({});
      await waitFor(
        runtime,
        () => result.key("canManage").get() as unknown as boolean,
        (value) => value === true,
        "the parent handler",
      );
      await waitFor(
        runtime,
        () =>
          result.key("rows").key(0).key("canManage")
            .get() as unknown as boolean,
        (value) => value === true,
        "the mapped row update",
      );

      result.key("rows").key(0).key("toggle").send({});
      expect(
        await waitFor(
          runtime,
          () => result.key("admins").get() as string[] | undefined,
          (value) => value?.includes("Alice") === true,
          "the captured parent handler",
        ),
      ).toEqual(["Alice"]);
      cancelSink();
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});

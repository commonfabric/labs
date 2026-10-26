import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";

import { LOCK_FILE, tryAdoptSpool } from "./spool.ts";

// The child is `deno eval` with an inline script that imports nothing, so
// the isolated-deno lockfile helper does not apply: there is no module
// graph to freeze, and the helper cannot kill a child mid-run, which is the
// point of this test.
const HOLDER_SCRIPT = `
const f = await Deno.open(Deno.args[0], { create: true, write: true });
const locked = await f.tryLock(true);
await Deno.stdout.write(
  new TextEncoder().encode(locked ? "LOCKED\\n" : "CONTENDED\\n"),
);
for await (const _ of Deno.stdin.readable) { /* hold until stdin closes */ }
f.close();
`;

describe("spool-death", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "test-records-death-" });
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  });

  describe("tryAdoptSpool()", () => {
    it("adopts a spool whose owner was killed without warning", async () => {
      const child = new Deno.Command(Deno.execPath(), {
        args: ["eval", HOLDER_SCRIPT, join(dir, LOCK_FILE)],
        stdin: "piped",
        stdout: "piped",
      }).spawn();
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe("LOCKED\n");

      expect(await tryAdoptSpool(dir)).toBeUndefined();

      child.kill("SIGKILL");
      await child.status;
      reader.releaseLock();
      await child.stdout.cancel().catch(() => {});
      await child.stdin.close().catch(() => {});

      const adopted = await tryAdoptSpool(dir);
      assert(adopted);
      adopted.close();
    });
  });
});

/**
 * Another process on the shared compiled-module cache
 * (`shared-compile-cache.test.ts`). Run with the cache directory and a
 * command:
 *
 * - `claim <key>`: takes the turn for `<key>`, prints `held`, and holds it
 *   until a line arrives on standard input or the process is killed. On a
 *   line it writes `<dir>/ended` and then ends the turn, so a test can tell
 *   that it waited for the end.
 * - `put <version> <count>`: puts `<count>` modules under `<version>` and
 *   prints `put`.
 */

import { openSharedCompileCache } from "../../src/compilation-cache/shared-compile-cache.deno.ts";

const [dir, command, ...rest] = Deno.args;
const { moduleByteCache, compileClaims } = openSharedCompileCache(dir);

if (command === "claim") {
  const endTurn = await compileClaims.take(rest[0]);
  console.log("held");
  for await (const _ of Deno.stdin.readable) break;
  await Deno.writeTextFile(`${dir}/ended`, "");
  endTurn();
} else if (command === "put") {
  const [version, count] = rest;
  moduleByteCache.putAll(
    version,
    Array.from({ length: Number(count) }, (_, index) => ({
      identity: `module-${index}`,
      js: `export const value = ${index};`.repeat(64),
    })),
  );
  console.log("put");
} else {
  throw new Error(`unknown command ${command}`);
}

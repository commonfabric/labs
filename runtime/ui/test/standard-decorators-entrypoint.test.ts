import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  readDenoConfig,
  runDenoCheckWithTemporaryConfig,
} from "@commonfabric/test-support/isolated-deno";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("ui entrypoint type-checks under standard decorators", async () => {
  const rootConfig = await readDenoConfig(join(ROOT, "deno.jsonc"));
  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files: ["runtime/ui/src/index.ts"],
    tempConfigPrefix: "deno.standard-decorators.ui-entrypoint",
  });

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(output.success, "ui entrypoint should pass under standard decorators");
});

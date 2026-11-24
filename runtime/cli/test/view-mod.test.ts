import { assertRejects } from "@std/assert";
import { ViewError, viewMain } from "../lib/view/mod.ts";

async function withTempFile(
  contents: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const path = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(path, contents);
    await fn(path);
  } finally {
    await Deno.remove(path);
  }
}

Deno.test("viewMain: empty input throws a clean ViewError (no stack trace)", async () => {
  await withTempFile("", async (path) => {
    await assertRejects(
      () =>
        viewMain({
          color: "never",
          plain: true,
          lineNumbers: false,
          file: path,
        }),
      ViewError,
    );
  });
});

Deno.test("viewMain: whitespace-only input is treated as empty", async () => {
  await withTempFile("  \n\n\t\n", async (path) => {
    await assertRejects(
      () =>
        viewMain({
          color: "never",
          plain: true,
          lineNumbers: false,
          file: path,
        }),
      ViewError,
    );
  });
});

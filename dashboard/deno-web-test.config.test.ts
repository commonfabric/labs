import { assertEquals } from "@std/assert";

/**
 * The config a fresh evaluation of `deno-web-test.config.ts` gives with `CI`
 * set as given. The module reads `CI` as it loads, so each call imports it
 * under a query of its own.
 */
async function configWith(ci: string | undefined): Promise<{ args: string[] }> {
  const previous = Deno.env.get("CI");
  try {
    if (ci === undefined) Deno.env.delete("CI");
    else Deno.env.set("CI", ci);
    return (await import(`./deno-web-test.config.ts?ci=${ci}`)).default;
  } finally {
    if (previous === undefined) Deno.env.delete("CI");
    else Deno.env.set("CI", previous);
  }
}

Deno.test("dashboard browser tests disable the Chromium sandbox in CI", async () => {
  assertEquals((await configWith("1")).args, ["--no-sandbox"]);
});

Deno.test("dashboard browser tests keep the Chromium sandbox outside CI", async () => {
  assertEquals((await configWith(undefined)).args, []);
});

import { expect } from "@std/expect";

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
  expect((await configWith("1")).args).toContain("--no-sandbox");
});

Deno.test("dashboard browser tests keep the Chromium sandbox outside CI", async () => {
  expect((await configWith(undefined)).args).not.toContain("--no-sandbox");
});

Deno.test("dashboard browser tests draw 2D canvases on the CPU in CI and outside it", async () => {
  expect((await configWith("1")).args).toContain("--disable-accelerated-2d-canvas");
  expect((await configWith(undefined)).args).toContain("--disable-accelerated-2d-canvas");
});

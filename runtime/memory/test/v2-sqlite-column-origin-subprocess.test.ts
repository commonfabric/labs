// The two column-origin binding failures that can only be reproduced with
// process-level permissions or cache state a fully-permitted in-process test
// cannot set up. Each runs a helper under `deno run` and inherits
// DENO_COVERAGE_DIR, so the helper's coverage of column-origin.ts joins the
// report.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const support = (name: string) =>
  fromFileUrl(new URL(`./support/${name}`, import.meta.url));

/** The deno cache dir, resolved the way deno resolves it, so the download probe
 *  can mirror the module cache while emptying the plug cache. */
async function denoDir(): Promise<string> {
  const { stdout } = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(stdout)).denoDir as string;
}

Deno.test("readEnv swallows a denied env read and falls through to release", async () => {
  // No --allow-env: Deno.env.get throws, readEnv's catch swallows it, and the
  // source resolves to the release rather than propagating the denial.
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-ffi",
      support("column-origin-env-probe.ts"),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    code,
    0,
    `env probe failed: ${new TextDecoder().decode(stderr)}`,
  );
  assertStringIncludes(new TextDecoder().decode(stdout), '"kind":"release"');
});

Deno.test("openSource reports when the pinned release can't be downloaded", async () => {
  // A scratch DENO_DIR that mirrors the real module cache but has an empty plug
  // cache: modules still resolve offline, but the libsqlite3 download misses the
  // cache and, with no --allow-net, cannot fetch — exercising the download-
  // failure branch without touching the network.
  const real = await denoDir();
  const scratch = await Deno.makeTempDir({ prefix: "column-origin-denodir-" });
  try {
    for await (const entry of Deno.readDir(real)) {
      if (entry.name === "plug") continue;
      await Deno.symlink(join(real, entry.name), join(scratch, entry.name));
    }
    await Deno.mkdir(join(scratch, "plug"));

    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-ffi",
        support("column-origin-download-probe.ts"),
      ],
      env: { DENO_DIR: scratch },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      code,
      0,
      `download probe failed: ${new TextDecoder().decode(stderr)}`,
    );
    // The probe prints `true` when openSource returned a problem, not a library.
    assertStringIncludes(new TextDecoder().decode(stdout), "true");
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("a labeled query fails loudly when column-origin can't bind", async () => {
  // The probe loads @db/sqlite (so its own library binds) and only then points
  // DENO_SQLITE_LOCAL at a build column-origin can't open, then runs a labeled
  // read through the server. The read must fail with the bind error rather than
  // return mislabeled rows. Isolated in a subprocess because the env change would
  // otherwise leak into sibling tests.
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-net",
      "--allow-ffi",
      "--allow-env",
      support("column-origin-server-probe.ts"),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    code,
    0,
    `server probe failed: ${new TextDecoder().decode(stderr)}`,
  );
  assertStringIncludes(
    new TextDecoder().decode(stdout),
    "CFC read labeling needs SQLite column-metadata FFI",
  );
});

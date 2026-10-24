/**
 * Which labs checkout `bin/cf` selects.
 *
 * Several checkouts coexisting is normal — worktrees, and a vendored labs
 * inside another repo, a supported layout (see launcher.test.ts) — so an
 * install must not pin `cf` to the checkout it came from. The lookup travels
 * with the script, which is what lets `deno task install-cf` ship a copy.
 *
 * These drive the real script rather than a reimplementation of its rules, and
 * stub each fake checkout's `launcher.ts` with a dependency-free script that
 * prints the root it was run from. Nothing is written inside the repository
 * and no real CLI runs.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const binCf = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
  "bin",
  "cf",
);

/**
 * A stub launcher that prints the checkout it lives in. `bin/cf` runs it with
 * `deno run` and no `--config`, so it must not import anything.
 */
const STUB_LAUNCHER = `
const here = decodeURIComponent(new URL("../..", import.meta.url).pathname)
  .replace(/\\/$/, "");
console.log(here);
`;

async function makeCheckout(
  root: string,
  { withEntry = false }: { withEntry?: boolean } = {},
): Promise<void> {
  await Deno.mkdir(join(root, "packages", "cli"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "packages", "cli", "launcher.ts"),
    STUB_LAUNCHER,
  );
  // Only `which` inspects the entry; the launcher stub stands in for it
  // everywhere else, so it is opt-in to keep the other cases minimal.
  if (withEntry) {
    await Deno.writeTextFile(join(root, "packages", "cli", "mod.ts"), "");
  }
}

/** Run `bin/cf` from `cwd` and return what the selected launcher printed. */
async function resolveFrom(
  cwd: string,
  env: Record<string, string> = {},
  args: string[] = ["ignored-arg"],
): Promise<{ code: number; out: string; err: string }> {
  const command = new Deno.Command(binCf, {
    args,
    cwd,
    env: { ...Deno.env.toObject(), ...env },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    out: new TextDecoder().decode(stdout).trim(),
    err: new TextDecoder().decode(stderr).trim(),
  };
}

async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "cf-resolution-" });
  // macOS reports /var as a symlink to /private/var; the script walks the
  // logical path, so compare against the resolved one.
  const real = await Deno.realPath(dir);
  try {
    await body(real);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a checkout is selected from a directory inside it", async () => {
  await withTempDir(async (dir) => {
    const labs = join(dir, "labs");
    await makeCheckout(labs);
    const deep = join(labs, "packages", "patterns");
    await Deno.mkdir(deep, { recursive: true });

    const { code, out } = await resolveFrom(deep);
    assertEquals(code, 0);
    assertEquals(out, labs);
  });
});

Deno.test("a vendoring host resolves to its vendored labs", async () => {
  await withTempDir(async (dir) => {
    const host = join(dir, "loom");
    await makeCheckout(join(host, "vendor", "labs"));
    const src = join(host, "src");
    await Deno.mkdir(src, { recursive: true });

    const { code, out } = await resolveFrom(src);
    assertEquals(code, 0);
    assertEquals(out, join(host, "vendor", "labs"));
  });
});

Deno.test("a vendoring host is found from any depth below it", async () => {
  // The realistic shape: working somewhere deep inside a loom instance, with
  // its labs several levels up. `vendor/labs` is tested at every ancestor, not
  // just the immediate parent.
  await withTempDir(async (dir) => {
    const host = join(dir, "loominstance");
    await makeCheckout(join(host, "vendor", "labs"));
    const deep = join(host, "foo", "bar", "baz");
    await Deno.mkdir(deep, { recursive: true });

    const { code, out } = await resolveFrom(deep);
    assertEquals(code, 0);
    assertEquals(out, join(host, "vendor", "labs"));
  });
});

Deno.test("a vendoring host is found from the host root itself", async () => {
  await withTempDir(async (dir) => {
    const host = join(dir, "loominstance");
    await makeCheckout(join(host, "vendor", "labs"));

    const { code, out } = await resolveFrom(host);
    assertEquals(code, 0);
    assertEquals(out, join(host, "vendor", "labs"));
  });
});

Deno.test("inside the vendored labs, that checkout wins over its host", async () => {
  // The nearer checkout is the answer; walking up to the host and re-deriving
  // `vendor/labs` would reach the same place here, but must not be relied on.
  await withTempDir(async (dir) => {
    const host = join(dir, "loom");
    const vendored = join(host, "vendor", "labs");
    await makeCheckout(vendored);
    const deep = join(vendored, "packages", "cli");

    const { code, out } = await resolveFrom(deep);
    assertEquals(code, 0);
    assertEquals(out, vendored);
  });
});

Deno.test("the nearest checkout wins when checkouts nest", async () => {
  await withTempDir(async (dir) => {
    const outer = join(dir, "outer");
    const inner = join(outer, "nested", "labs");
    await makeCheckout(outer);
    await makeCheckout(inner);

    const { code, out } = await resolveFrom(inner);
    assertEquals(code, 0);
    assertEquals(out, inner);
  });
});

Deno.test("outside any checkout, the script's own checkout is used", async () => {
  await withTempDir(async (dir) => {
    const labs = join(dir, "labs");
    await makeCheckout(labs);
    const link = join(dir, "cf-link");
    await Deno.symlink(join(labs, "bin", "cf"), link);
    await Deno.mkdir(join(labs, "bin"), { recursive: true });
    await Deno.copyFile(binCf, join(labs, "bin", "cf"));
    await Deno.chmod(join(labs, "bin", "cf"), 0o755);

    const elsewhere = join(dir, "elsewhere");
    await Deno.mkdir(elsewhere, { recursive: true });

    const command = new Deno.Command(link, {
      args: ["ignored-arg"],
      cwd: elsewhere,
      env: Deno.env.toObject(),
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await command.output();
    assertEquals(code, 0);
    // Followed the symlink back to the checkout it lives in, not $PWD.
    assertEquals(new TextDecoder().decode(stdout).trim(), labs);
  });
});

Deno.test("`which` reports the CLI that would run, on stdout alone", async () => {
  // Answered by the wrapper: asking the CLI which CLI would run begs the
  // question. stdout stays a bare path so a script can consume it.
  await withTempDir(async (dir) => {
    const labs = join(dir, "labs");
    await makeCheckout(labs, { withEntry: true });
    const deep = join(labs, "packages");
    await Deno.mkdir(deep, { recursive: true });

    const { code, out, err } = await resolveFrom(deep, {}, ["which"]);
    assertEquals(code, 0);
    // stdout is the checkout: the part that varies, and a bare path scripts
    // can consume. The entry file is constant and belongs on stderr.
    assertEquals(out, labs);
    assertStringIncludes(err, join(labs, "packages", "cli", "mod.ts"));
    assertStringIncludes(err, "nearest checkout");
  });
});

Deno.test("`which` reports an entry that is not there", async () => {
  // The checkout test only proves launcher.ts exists; the entry is a separate
  // file. A diagnostic that names a path it never checked is worse than one
  // that admits it cannot find it.
  await withTempDir(async (dir) => {
    const labs = join(dir, "labs");
    await makeCheckout(labs); // writes launcher.ts, not mod.ts

    const { code, out, err } = await resolveFrom(labs, {}, ["which"]);
    assertEquals(code, 1);
    // The checkout still resolved, so it is still the answer to report.
    assertEquals(out, labs);
    assertStringIncludes(err, "does not exist");
    assertStringIncludes(err, join(labs, "packages", "cli", "mod.ts"));
  });
});

Deno.test("`which` names CF_LABS_ROOT as the reason when it applies", async () => {
  await withTempDir(async (dir) => {
    const here = join(dir, "here");
    const elsewhere = join(dir, "elsewhere");
    await makeCheckout(here);
    await makeCheckout(elsewhere, { withEntry: true });

    const { code, out, err } = await resolveFrom(here, {
      CF_LABS_ROOT: elsewhere,
    }, ["which"]);
    assertEquals(code, 0);
    assertEquals(out, elsewhere);
    assertStringIncludes(err, "CF_LABS_ROOT");
  });
});

Deno.test("`which` is only intercepted as the first argument", async () => {
  // `cf piece call ... which` must still reach the CLI.
  await withTempDir(async (dir) => {
    const labs = join(dir, "labs");
    await makeCheckout(labs);

    const { code, out } = await resolveFrom(labs, {}, [
      "piece",
      "call",
      "which",
    ]);
    assertEquals(code, 0);
    // The stub launcher ran, so the argument was forwarded rather than caught.
    assertEquals(out, labs);
  });
});

Deno.test("CF_LABS_ROOT overrides the cwd", async () => {
  await withTempDir(async (dir) => {
    const here = join(dir, "here");
    const elsewhere = join(dir, "elsewhere");
    await makeCheckout(here);
    await makeCheckout(elsewhere);

    const { code, out } = await resolveFrom(here, { CF_LABS_ROOT: elsewhere });
    assertEquals(code, 0);
    assertEquals(out, elsewhere);
  });
});

Deno.test("a CF_LABS_ROOT that is not a checkout fails loudly", async () => {
  // Explicitly wrong input must not fall through to the cwd or the script's
  // own checkout: the caller asked for something specific.
  await withTempDir(async (dir) => {
    const labs = join(dir, "labs");
    await makeCheckout(labs);
    const bogus = join(dir, "not-labs");
    await Deno.mkdir(bogus, { recursive: true });

    const { code, out, err } = await resolveFrom(labs, {
      CF_LABS_ROOT: bogus,
    });
    assertEquals(code, 2);
    assertEquals(out, "");
    assertStringIncludes(err, "not a labs checkout");
    assertStringIncludes(err, bogus);
  });
});

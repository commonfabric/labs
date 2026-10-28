/**
 * `deno task install-cf` — putting `cf` and `cfsh` on PATH without mise.
 *
 * It installs a copy, not a link. `bin/cf` is self-contained: it works out
 * which checkout to run from `$CF_LABS_ROOT` or the cwd, neither of which
 * depends on where the copy itself lives. So no particular checkout has to
 * survive for the install to keep working — which matters here, where
 * worktrees are created and removed routinely.
 *
 * The one thing a copy cannot infer is which checkout to use when you are
 * outside every checkout, so the installer bakes that in. `bin/cfsh` needs no
 * such default: it opens a shuttle through whatever `cf` is on PATH, so it is
 * shipped beside the other and baked with nothing. The properties worth
 * guarding are therefore that a copy is independent of its source, that the
 * baked default actually lands, and that both copies arrive and are named.
 *
 * Each case runs the real script against a fake checkout in a temp dir, with
 * an explicit `--dir`, so nothing touches the repository or the user's PATH.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..", "..", "..");
const installer = join(repoRoot, "scripts", "install-cf.sh");

/**
 * Runs `git` in `cwd`, throwing with git's own error output when it fails, so
 * a fixture that could not be built says so rather than surfacing later as an
 * installer failure.
 */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `\`git ${args.join(" ")}\` exited ${code}: ${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
}

/** A git checkout with a `bin/cf` and a `bin/cfsh`, standing in for a real one. */
async function makeCheckout(
  root: string,
  // The installer rewrites this line, and fails loudly if it is absent, so the
  // stand-in has to carry it like the real bin/cf does.
  binContents = '#!/bin/sh\nDEFAULT_LABS_ROOT=""\n',
): Promise<void> {
  await Deno.mkdir(join(root, "bin"), { recursive: true });
  await Deno.writeTextFile(join(root, "bin", "cf"), binContents);
  await Deno.chmod(join(root, "bin", "cf"), 0o755);
  // The installer ships both, so a checkout missing one is not a checkout.
  // This carries no checkout to rewrite, which is why it needs no marker line.
  await Deno.writeTextFile(
    join(root, "bin", "cfsh"),
    '#!/bin/sh\nexec cf sh "$@"\n',
  );
  await Deno.chmod(join(root, "bin", "cfsh"), 0o755);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  // A commit starts git's automatic maintenance, which carries on in the
  // background after the commit returns. Its worktree pruning can delete the
  // admin directory of a worktree that `git worktree add` has created but not
  // yet locked, so a worktree added straight after a commit would fail now and
  // then.
  await git(root, "config", "maintenance.auto", "false");
}

async function runInstaller(
  cwd: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const { code, stdout, stderr } = await new Deno.Command(installer, {
    args,
    cwd,
    env: { ...Deno.env.toObject(), SHELL: "/bin/zsh" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  };
}

async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "install-cf-" });
  const real = await Deno.realPath(dir);
  try {
    await body(real);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("installs a copy, independent of its source", async () => {
  // Deleting or changing the source checkout must not reach back into an
  // install that is already on someone's PATH.
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(
      checkout,
      '#!/bin/sh\nDEFAULT_LABS_ROOT=""\necho original\n',
    );
    await Deno.mkdir(target);

    assertEquals((await runInstaller(checkout, ["--dir", target])).code, 0);

    const info = await Deno.lstat(join(target, "cf"));
    assertFalse(info.isSymlink, "expected a real file, not a link");
    assertStringIncludes(
      await Deno.readTextFile(join(target, "cf")),
      "original",
    );

    await Deno.remove(checkout, { recursive: true });
    assertStringIncludes(
      await Deno.readTextFile(join(target, "cf")),
      "original",
    );
  });
});

Deno.test("copies this checkout's script, but defaults to the primary", async () => {
  // Two separate questions. The script is the one whose task you invoked —
  // including changes not yet on main. The baked default is the primary, so it
  // survives removing the worktree you installed from.
  await withTempDir(async (dir) => {
    const primary = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(
      primary,
      '#!/bin/sh\nDEFAULT_LABS_ROOT=""\necho primary-version\n',
    );
    await Deno.mkdir(join(primary, "packages", "cli"), { recursive: true });
    await Deno.writeTextFile(
      join(primary, "packages", "cli", "launcher.ts"),
      "",
    );
    await Deno.mkdir(target);

    // A real worktree of that repo, carrying a different bin/cf.
    const worktree = join(dir, "wt");
    await git(primary, "commit", "-qm", "init", "--allow-empty");
    await git(primary, "worktree", "add", "-q", "--detach", worktree);
    await Deno.mkdir(join(worktree, "bin"), { recursive: true });
    await Deno.writeTextFile(
      join(worktree, "bin", "cf"),
      '#!/bin/sh\nDEFAULT_LABS_ROOT=""\necho worktree-version\n',
    );
    await Deno.writeTextFile(
      join(worktree, "bin", "cfsh"),
      '#!/bin/sh\nexec cf sh "$@"\n',
    );

    const { code, err } = await runInstaller(worktree, ["--dir", target]);
    assertEquals(code, 0, err);

    const installed = await Deno.readTextFile(join(target, "cf"));
    assertStringIncludes(installed, "worktree-version");
    assertStringIncludes(installed, `DEFAULT_LABS_ROOT="${primary}"`);
  });
});

Deno.test("bakes the checkout default into the copy", async () => {
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(checkout);
    await Deno.mkdir(target);

    assertEquals((await runInstaller(checkout, ["--dir", target])).code, 0);
    assertStringIncludes(
      await Deno.readTextFile(join(target, "cf")),
      `DEFAULT_LABS_ROOT="${checkout}"`,
    );
  });
});

Deno.test("the shebang stays on line 1", async () => {
  // The install marker is inserted after it; ahead of it the file is not
  // executable as a script at all.
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(checkout);
    await Deno.mkdir(target);

    assertEquals((await runInstaller(checkout, ["--dir", target])).code, 0);
    const lines = (await Deno.readTextFile(join(target, "cf"))).split("\n");
    assertEquals(lines[0], "#!/bin/sh");
    assertStringIncludes(lines[1], "installed by scripts/install-cf.sh");
  });
});

Deno.test("re-running upgrades an existing install", async () => {
  // This is the upgrade path, since a copy does not track its source.
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(
      checkout,
      '#!/bin/sh\nDEFAULT_LABS_ROOT=""\necho original\n',
    );
    await Deno.mkdir(target);

    assertEquals((await runInstaller(checkout, ["--dir", target])).code, 0);
    await Deno.writeTextFile(
      join(checkout, "bin", "cf"),
      '#!/bin/sh\nDEFAULT_LABS_ROOT=""\necho upgraded\n',
    );
    assertEquals((await runInstaller(checkout, ["--dir", target])).code, 0);

    assertStringIncludes(
      await Deno.readTextFile(join(target, "cf")),
      "upgraded",
    );
  });
});

Deno.test("reports what it installed", async () => {
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(checkout);
    await Deno.mkdir(target);

    const { code, out } = await runInstaller(checkout, ["--dir", target]);
    assertEquals(code, 0);
    assertStringIncludes(out, join(target, "cf"));
    assertStringIncludes(out, checkout);
  });
});

Deno.test("installs cfsh beside cf, with no checkout baked into it", async () => {
  // The shell's documented entry point is only real if it lands on a PATH.
  // It carries no checkout of its own — it forwards to `cf sh` and finds `cf`
  // by name — so the copy takes the marker and nothing else.
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(checkout);
    await Deno.mkdir(target);

    const { code, out } = await runInstaller(checkout, ["--dir", target]);
    assertEquals(code, 0);
    assertStringIncludes(out, join(target, "cfsh"));

    const installed = await Deno.readTextFile(join(target, "cfsh"));
    assertStringIncludes(installed, "# installed by scripts/install-cf.sh");
    assertEquals(installed.split("\n")[0], "#!/bin/sh");
    assertEquals(installed.includes("DEFAULT_LABS_ROOT"), false);
    assertEquals((await Deno.stat(join(target, "cfsh"))).mode! & 0o111, 0o111);
  });
});

Deno.test("prints the completion line without editing any rc", async () => {
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(checkout);
    await Deno.mkdir(target);

    const { out } = await runInstaller(checkout, ["--dir", target]);
    assertStringIncludes(out, "source <(cf completion zsh)");
    assertStringIncludes(out, "not installed automatically");
  });
});

Deno.test("is idempotent", async () => {
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(checkout);
    await Deno.mkdir(target);

    assertEquals((await runInstaller(checkout, ["--dir", target])).code, 0);
    assertEquals((await runInstaller(checkout, ["--dir", target])).code, 0);
    assert((await Deno.lstat(join(target, "cf"))).isFile);
  });
});

Deno.test("refuses to clobber a real file", async () => {
  // Something the user put there by hand is not ours to replace.
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(checkout);
    await Deno.mkdir(target);
    await Deno.writeTextFile(join(target, "cf"), "mine, do not touch\n");

    const { code, err } = await runInstaller(checkout, ["--dir", target]);
    assertEquals(code, 1);
    assertStringIncludes(err, "not installed by this script");
    assertEquals(
      await Deno.readTextFile(join(target, "cf")),
      "mine, do not touch\n",
    );
  });
});

Deno.test("dry run changes nothing", async () => {
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(checkout);
    await Deno.mkdir(target);

    const { code, out } = await runInstaller(checkout, [
      "--dir",
      target,
      "--dry-run",
    ]);
    assertEquals(code, 0);
    assertStringIncludes(out, "would install");
    assertEquals(await Deno.stat(join(target, "cf")).catch(() => null), null);
  });
});

Deno.test("a dry run predicts a failing real run", async () => {
  // A dry run that reports success where the real run would fail is worse than
  // no dry run: it is the wrong answer, delivered confidently.
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    await makeCheckout(checkout);

    const { code, err } = await runInstaller(checkout, [
      "--dir",
      join(dir, "does-not-exist"),
      "--dry-run",
    ]);
    assertEquals(code, 1);
    assertStringIncludes(err, "does not exist");
  });
});

Deno.test("warns when an explicit --dir is not on PATH", async () => {
  // Auto-detection only picks directories on PATH. An explicit --dir is
  // honored, but installing somewhere unreachable is the exact silent failure
  // this whole area exists to prevent, so it is said out loud.
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    const target = join(dir, "target");
    await makeCheckout(checkout);
    await Deno.mkdir(target);

    const { code, err } = await runInstaller(checkout, ["--dir", target]);
    assertEquals(code, 0);
    assertStringIncludes(err, "not on your PATH");
  });
});

Deno.test("a missing target directory is an error, not a silent success", async () => {
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    await makeCheckout(checkout);

    const { code, err } = await runInstaller(checkout, [
      "--dir",
      join(dir, "does-not-exist"),
    ]);
    assertEquals(code, 1);
    assertStringIncludes(err, "does not exist");
  });
});

Deno.test("an unknown argument is rejected", async () => {
  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    await makeCheckout(checkout);

    const { code, err } = await runInstaller(checkout, ["--nope"]);
    assertEquals(code, 2);
    assertStringIncludes(err, "unknown argument");
  });
});

Deno.test("the help names both of the things it installs", async () => {
  // A person who cannot find `cfsh` in the help has no way to learn it was
  // installed, which makes shipping it and not saying so the same as not
  // shipping it.

  await withTempDir(async (dir) => {
    const checkout = join(dir, "labs");
    await makeCheckout(checkout);

    const { code, out } = await runInstaller(checkout, ["--help"]);
    assertEquals(code, 0);
    assertStringIncludes(out, "bin/cf");
    assertStringIncludes(out, "bin/cfsh");
  });
});

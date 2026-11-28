import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { expect } from "@std/expect";
import {
  readDenoConfig,
  removeIfPresent,
  runDenoCheckWithTemporaryConfig,
  runDenoCommandWithTemporaryLock,
  runFrozenDriftCheck,
} from "./isolated-deno.ts";
import { test } from "@commonfabric/test-support/test";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

test({
  name: "a task's `deno` is the Deno running the task, not one on PATH",
  ignore: Deno.build.os === "windows",
  async fn() {
    // Test tasks build their own run allowlist with `--allow-run="$(deno
    // eval "console.log(Deno.execPath())")"`, which names the binary they
    // start only while a task's `deno` is the Deno running the task. A `deno`
    // found on `PATH` instead would name a different binary whenever the
    // shell's Deno is not the pinned one, which is the case those tasks exist
    // to handle. The decoy below is the only `deno` on the child's `PATH`, so
    // it runs if the resolution ever goes through `PATH`.

    const directory = await Deno.makeTempDir({
      prefix: "commonfabric-task-deno-",
    });
    try {
      const binDirectory = join(directory, "bin");
      await Deno.mkdir(binDirectory);
      const decoy = join(binDirectory, "deno");
      await Deno.writeTextFile(decoy, "#!/bin/sh\necho DECOY\n");
      await Deno.chmod(decoy, 0o755);
      await Deno.writeTextFile(
        join(directory, "deno.json"),
        JSON.stringify({
          tasks: { probe: 'deno eval "console.log(Deno.execPath())"' },
        }),
      );

      const output = await new Deno.Command(Deno.execPath(), {
        args: ["task", "probe"],
        cwd: directory,
        env: { PATH: binDirectory },
        stdout: "piped",
        stderr: "piped",
      }).output();

      const stdout = decode(output.stdout);
      assert(
        output.success,
        `task failed:\n${stdout}\n${decode(output.stderr)}`,
      );
      assert(
        !stdout.includes("DECOY"),
        `the task ran the \`deno\` on PATH:\n${stdout}`,
      );
      assertEquals(stdout.trim(), Deno.execPath());
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

test("nested checks use the checked-in dependency graph", async () => {
  const lockPath = join(ROOT, "deno.lock");
  const lockBefore = await Deno.readTextFile(lockPath);
  const rootConfig = await readDenoConfig(join(ROOT, "deno.jsonc"));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files: ["base/test-support/src/mod.ts"],
    tempConfigPrefix: "deno.test-support.frozen-check",
  });

  assert(
    output.success,
    `nested check failed:\n${decode(output.stdout)}\n${decode(output.stderr)}`,
  );
  assertEquals(await Deno.readTextFile(lockPath), lockBefore);
});

test("a command with a temporary lock runs in the environment it is given", async () => {
  const output = await runDenoCommandWithTemporaryLock({
    root: ROOT,
    args: (lockPath) => [
      "eval",
      "--lock",
      lockPath,
      "console.log(Deno.env.get('CF_ISOLATED_DENO_PROBE'), Deno.cwd())",
    ],
    env: { CF_ISOLATED_DENO_PROBE: "given" },
  });

  assert(output.success, decode(output.stderr));
  assertEquals(decode(output.stdout).trim(), `given ${ROOT}`);
});

test("a command with a temporary lock inherits this process's environment unless it clears it", async () => {
  const probe = async (clearEnv: boolean) => {
    const output = await runDenoCommandWithTemporaryLock({
      root: ROOT,
      args: (lockPath) => [
        "eval",
        "--lock",
        lockPath,
        "console.log(Deno.env.get('CF_ISOLATED_DENO_PROBE'), Deno.env.has('HOME'))",
      ],
      env: { CF_ISOLATED_DENO_PROBE: "given" },
      clearEnv,
    });
    return { code: output.code, stdout: decode(output.stdout) };
  };

  expect(await probe(false)).toEqual({ code: 0, stdout: "given true\n" });
  expect(await probe(true)).toEqual({ code: 0, stdout: "given false\n" });
});

test("nested frozen checks reject dependency graph drift", async () => {
  // A frozen check rejects a config whose dependency graph no longer matches
  // its lockfile. Proving that against the whole workspace would force Deno to
  // re-resolve every npm package from the registry, so this uses a small
  // self-contained workspace instead. The imports are two of the repository's
  // own JSR dependencies, pinned to the versions the checked-in lock resolves,
  // so generating the baseline lock needs only manifests the dependency cache
  // already holds and the check needs no network.
  const rootImports =
    (await readDenoConfig(join(ROOT, "deno.jsonc"))).imports ?? {};
  const lock = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.lock")));
  const pathRange = rootImports["@std/path"];
  const assertRange = rootImports["@std/assert"];
  assert(
    pathRange && assertRange,
    "root config should declare @std/path and @std/assert",
  );
  const pathVersion = lock.specifiers?.[pathRange];
  const assertVersion = lock.specifiers?.[assertRange];
  assert(
    pathVersion && assertVersion,
    "deno.lock should pin @std/path and @std/assert",
  );
  const pathImport = `jsr:@std/path@${pathVersion}`;
  const assertImport = `jsr:@std/assert@${assertVersion}`;

  const { generate, check } = await runFrozenDriftCheck({
    baselineImports: {
      "@std/path": pathImport,
      "@std/assert": assertImport,
    },
    // The entry never imports @std/assert, so dropping it leaves an entry that
    // still type-checks while the config no longer matches the generated lock.
    driftedImports: { "@std/path": pathImport },
    entrySource: `import { join } from "@std/path";\n` +
      `export const joined = join("a", "b");\n`,
  });

  assert(
    generate.success,
    `baseline lock generation failed:\n${decode(generate.stdout)}\n${
      decode(generate.stderr)
    }`,
  );
  assert(!check.success, "a drifted dependency graph should fail the check");
  assertMatch(decode(check.stderr), /lockfile is out of date/i);
});

test("a child records nothing and skips nothing unless the caller says so", async () => {
  // A child's tests are the caller's fixtures, so the recording variables the
  // caller's own run carries do not reach it.

  const read = (env?: Record<string, string>) =>
    runDenoCommandWithTemporaryLock({
      root: ROOT,
      args: (lock) => [
        "eval",
        `--lock=${lock}`,
        "console.log(JSON.stringify([" +
        'Deno.env.get("CF_TEST_RECORDS_DIR"), ' +
        'Deno.env.get("CF_TEST_SKIP_LIST")]))',
      ],
      ...(env === undefined ? {} : { env }),
    });
  assertEquals(JSON.parse(decode((await read()).stdout)), ["", ""]);
  assertEquals(
    JSON.parse(
      decode(
        (await read({
          CF_TEST_RECORDS_DIR: "/spool",
          CF_TEST_SKIP_LIST: "/skip.json",
        })).stdout,
      ),
    ),
    ["/spool", "/skip.json"],
  );
});

test("a config that cannot be written fails with its own error, leaving nothing behind", async () => {
  // The temporary config is never created, so cleaning it up finds nothing to
  // remove; the caller sees why the config could not be written instead.
  const prefix = `deno.test-support.unwritable-${crypto.randomUUID()}`;

  await assertRejects(
    () =>
      runDenoCheckWithTemporaryConfig({
        root: ROOT,
        config: { compilerOptions: { target: 1n } },
        files: ["base/test-support/src/mod.ts"],
        tempConfigPrefix: prefix,
      }),
    TypeError,
    "BigInt",
  );

  for await (const entry of Deno.readDir(ROOT)) {
    assert(!entry.name.includes(prefix), `left behind ${entry.name}`);
  }
});

test("removeIfPresent() removes a present path, and returns for an absent one", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const present = join(directory, "present");
    await Deno.mkdir(join(present, "inner"), { recursive: true });

    await removeIfPresent(present, { recursive: true });
    await removeIfPresent(present, { recursive: true });

    await expect(Deno.lstat(present)).rejects.toThrow(Deno.errors.NotFound);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

test("removeIfPresent() throws for a path it cannot remove for a reason other than absence", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const file = join(directory, "file");
    await Deno.writeTextFile(file, "kept\n");

    await expect(removeIfPresent(join(file, "inner"))).rejects.toThrow(
      Deno.errors.NotADirectory,
    );
    expect(await Deno.readTextFile(file)).toBe("kept\n");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

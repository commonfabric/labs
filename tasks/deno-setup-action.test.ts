import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, fromFileUrl, globToRegExp, join } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const ACTION_PATH = join(
  REPO_ROOT,
  ".github",
  "actions",
  "deno-setup",
  "action.yml",
);

function actionStep(action: string, name: string): string {
  const header = `    - name: ${name}`;
  const start = action.indexOf(header);
  assert(start >= 0, `\`${name}\` step not found`);
  const next = action.indexOf("\n    - name:", start + header.length);
  return action.slice(start, next < 0 ? action.length : next);
}

function shellScript(step: string): string {
  const marker = "      run: ";
  const start = step.indexOf(marker);
  assert(start >= 0, "cache-miss cleanup shell script not found");
  return step.slice(start + marker.length).split("\n", 1)[0];
}

Deno.test(
  "Deno setup removes a partial toolchain after cache extraction fails",
  async () => {
    const root = await Deno.makeTempDir({
      prefix: "deno-toolchain-cache-test-",
    });
    try {
      const toolchainDir = join(root, "toolcache", "deno", "2.8.1");
      const binDir = join(toolchainDir, "x64");
      const bin = join(binDir, "deno");
      await Deno.mkdir(binDir, { recursive: true });
      await Deno.writeTextFile(
        bin,
        "#!/usr/bin/env bash\n" +
          'echo "Bus error (core dumped)" >&2\n' +
          "exit 135\n",
      );
      await Deno.chmod(bin, 0o755);

      const action = await Deno.readTextFile(ACTION_PATH);
      assertStringIncludes(
        action,
        "key: deno-bin-${{ runner.os }}-${{ runner.arch }}-" +
          "${{ steps.resolve.outputs.version }}",
      );
      const step = actionStep(
        action,
        "🧹 Clear Deno toolchain after cache miss",
      );
      assertStringIncludes(
        step,
        "if: steps.deno-toolchain-cache.outputs.cache-hit != 'true'",
      );
      const output = await new Deno.Command("bash", {
        args: [
          "--noprofile",
          "--norc",
          "-e",
          "-o",
          "pipefail",
          "-c",
          shellScript(step),
        ],
        env: {
          TOOLCHAIN_DIR: toolchainDir,
        },
      }).output();
      const stderr = new TextDecoder().decode(output.stderr);

      assertEquals(
        output.code,
        0,
        `cached Deno recovery exited ${output.code}:\n${stderr}`,
      );
      await assertRejects(
        () => Deno.stat(toolchainDir),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "Deno setup snapshots the dependency hash before registering the cache",
  async () => {
    const action = await Deno.readTextFile(ACTION_PATH);
    const hashStepName = "🧮 Resolve Deno dependency hash";
    const cacheStepName = "📦 Cache Deno dependencies";
    const hashStep = actionStep(action, hashStepName);
    const cacheStep = actionStep(action, cacheStepName);

    assert(
      action.indexOf(hashStepName) < action.indexOf(cacheStepName),
      "dependency hash must be resolved before the cache action is registered",
    );
    assertStringIncludes(
      hashStep,
      "DEPENDENCY_HASH: ${{ hashFiles('**/deno.jsonc', '**/deno.lock') }}",
    );
    assertStringIncludes(hashStep, "id: dependency-hash");
    assertStringIncludes(hashStep, "if: inputs.cache == 'true'");
    assertStringIncludes(
      hashStep,
      `printf 'hash=%s\\n' "$DEPENDENCY_HASH" >> "$GITHUB_OUTPUT"`,
    );
    assert(
      !cacheStep.includes("hashFiles("),
      "the cache action would reevaluate `hashFiles()` during its post-job save",
    );
    assertStringIncludes(
      cacheStep,
      "${{ steps.dependency-hash.outputs.hash }}",
    );
  },
);

Deno.test(
  "Deno setup leaves V8's code cache out of the dependency cache",
  async () => {
    // A process that loads a module from V8's code cache reports that module's
    // top-level code to the coverage profiler as one function-wide range, so a
    // restored code cache marks lines covered that never ran, and only for
    // modules unchanged since the cache was saved.

    const action = await Deno.readTextFile(ACTION_PATH);
    const cacheStep = actionStep(action, "📦 Cache Deno dependencies");
    const pathBlock = cacheStep.match(/\n {8}path: \|\n((?: {10}\S.*\n)+)/);
    assert(pathBlock, "cache step `path` block not found");
    const patterns = pathBlock[1].trim().split(/\s*\n\s*/);
    const includes = patterns
      .filter((pattern) => !pattern.startsWith("!"))
      .map((pattern) => globToRegExp(pattern));
    const exclusions = patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => globToRegExp(pattern.slice(1)));
    // `actions/cache` archives each path that an inclusion matches and no
    // exclusion does, with everything beneath it. An exclusion is tested only
    // against the paths the inclusions match, not against their contents.
    const archived = (path: string) => {
      const segments = path.split("/");
      for (let length = segments.length; length > 0; length--) {
        const prefix = segments.slice(0, length).join("/");
        if (
          includes.some((re) => re.test(prefix)) &&
          !exclusions.some((re) => re.test(prefix))
        ) {
          return true;
        }
      }
      return false;
    };

    for (const dir of ["~/.deno", "~/.cache/deno", "~/Library/Caches/deno"]) {
      for (
        const file of [
          "v8_code_cache_v2",
          "v8_code_cache_v2-shm",
          "v8_code_cache_v2-wal",
        ]
      ) {
        assert(!archived(`${dir}/${file}`), `${dir}/${file} is cached`);
      }
      for (
        const file of [
          "npm/registry.npmjs.org/react/19.1.0/package.json",
          "remote/https/deno.land/std/mod.ts",
          "dep_analysis_cache_v2",
        ]
      ) {
        assert(archived(`${dir}/${file}`), `${dir}/${file} is not cached`);
      }
    }
  },
);

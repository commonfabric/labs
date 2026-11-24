/**
 * What starting `cf` and the Topics client makes Deno read.
 *
 * `deno run` walks the static import graph of its entry before it runs
 * anything, reading every module and following every statement that is not
 * written `import type`, so what these graphs hold is most of what a start
 * costs. Nothing fails when an import widens one, and the run just gets slower,
 * so the limits here are what notices.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path/from-file-url";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import { buildCfLauncherCommand } from "../launcher.ts";

const REPO_ROOT = fromFileUrl(new URL("../../../", import.meta.url));

/** A module as `deno info --json` reports it. */
interface InfoModule {
  /** What the module is, as the graph names it. */
  specifier: string;

  /** What the module imports. A type-only import has no `code` entry. */
  dependencies?: {
    isDynamic?: boolean;
    code?: { specifier?: string };
  }[];
}

/** What `deno info --json` reports of a graph. */
interface Info {
  /** The entry the graph was built from. */
  roots: string[];

  /** Every module on the graph, deferred imports included. */
  modules: InfoModule[];

  /** Specifiers that stand for another, such as a version range. */
  redirects: Record<string, string>;
}

/** The modules `deno run` reads on starting `entry`, by specifier. */
async function startGraph(entry: string): Promise<Set<string>> {
  const { code, stdout, stderr } = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lock) => [
      "info",
      "--json",
      "--quiet",
      "--config",
      `${REPO_ROOT}deno.jsonc`,
      "--lock",
      lock,
      `${REPO_ROOT}${entry}`,
    ],
  });
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  const info: Info = JSON.parse(new TextDecoder().decode(stdout));
  const modules = new Map(
    info.modules.map((module) => [module.specifier, module]),
  );
  const resolved = (specifier: string): string => {
    let current = specifier;
    while (info.redirects[current] !== undefined) {
      current = info.redirects[current];
    }
    return current;
  };
  const reached = new Set<string>();
  const pending = info.roots.map(resolved);
  while (pending.length > 0) {
    const specifier = pending.pop()!;
    if (reached.has(specifier)) continue;
    reached.add(specifier);
    for (const dependency of modules.get(specifier)?.dependencies ?? []) {
      const target = dependency.code?.specifier;
      if (target !== undefined && !dependency.isDynamic) {
        pending.push(resolved(target));
      }
    }
  }
  return reached;
}

/** Paths and packages only a command that compiles or serves should reach. */
const COMPILER_AND_SERVER = [
  "npm:/typescript@",
  "base/ts-transformers/src/cf-pipeline.ts",
  "base/schema-generator/",
  "jsr.io/@db/sqlite/",
  "runtime/memory/v2/engine.ts",
  "runtime/cf-harness/",
  "runtime/html/",
  "runtime/state-inspector/",
];

function reachedAmong(graph: Set<string>, needles: readonly string[]) {
  return needles.filter((needle) =>
    [...graph].some((specifier) => specifier.includes(needle))
  );
}

describe("what starting a command reads", () => {
  it("reads no command to print the root's help", async () => {
    const graph = await startGraph("runtime/cli/mod.ts");
    expect(reachedAmong(graph, [
      "runtime/cli/commands/piece.ts",
      "runtime/runner/",
    ])).toEqual([]);
    expect(graph.size).toBeLessThan(120);
  });

  for (const command of ["piece", "cell"]) {
    it(`reads neither compiler nor server for \`cf ${command}\``, async () => {
      const graph = await startGraph(`runtime/cli/commands/${command}.ts`);
      expect(reachedAmong(graph, COMPILER_AND_SERVER)).toEqual([]);
      expect(graph.size).toBeLessThan(900);
    });
  }

  it("reads a fraction of the runner for the Topics client", async () => {
    const graph = await startGraph("patterns/apps/topics/tools/topics.ts");
    expect(reachedAmong(graph, [
      // What it reads of `runtime/html/` is the display fit, to redact output.
      ...COMPILER_AND_SERVER.filter((needle) => needle !== "runtime/html/"),
      "runtime/html/src/worker/mod.ts",
      "runtime/runner/src/runtime.ts",
      "runtime/runner/src/index.ts",
      "patterns/apps/topics/tools/browser.ts",
    ])).toEqual([]);
    expect(graph.size).toBeLessThan(350);
  });

  it("starts with the option that keeps a deferred command out of the walk", () => {
    const { args } = buildCfLauncherCommand({
      denoPath: "deno",
      labsRoot: "/labs",
      configPath: "/labs/deno.jsonc",
      cliEntrypoint: "/labs/runtime/cli/mod.ts",
      cwd: "/labs",
      cfArgs: [],
    });
    expect(args).toContain("--unstable-lazy-dynamic-imports");
  });
});

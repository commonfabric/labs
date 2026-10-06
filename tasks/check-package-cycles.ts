#!/usr/bin/env -S deno run --allow-read --allow-run=git

/**
 * Fails CI when the workspace packages import each other in a circle.
 *
 * A package cycle is two or more packages that can each reach the other by
 * following imports. It is worth a gate of its own because it defeats the
 * stack that AGENTS.md describes under "Pace Layers": a package in a cycle
 * cannot be read, tested, replaced, or reasoned about without its partner, so
 * the two are one package wearing two names. A cycle also hides which side owns
 * a concept, which is how a user-interface primitive ends up wired into the
 * foundation.
 *
 * The check builds a graph whose nodes are workspace members and whose edges
 * are the imports between them, finds every group of members that can reach
 * each other, and compares that set against the ALLOWLIST below. A group that
 * is not on the list fails. So does an allowlisted group that has gained or
 * lost a member, and so does an allowlisted group that is no longer a cycle at
 * all — the list may only shrink, and an entry that has been fixed has to go.
 *
 * Scope is production source. A test reaches for whatever it needs to drive the
 * thing under test — a runner test starts a toolshed server, a package's own
 * integration tests import the harness that runs them — and treating that as a
 * layering claim would collapse most of the workspace into one group and say
 * nothing. Excluded, therefore: any file under a `test`, `tests`, `integration`,
 * or `bench` directory inside a package, and any file named `*.test.*` or
 * `*.bench.*` wherever it sits, which is how `packages/ui` and
 * `packages/patterns` keep a test beside its subject.
 *
 * An edge is one file naming another package, either by package name
 * (`@commonfabric/runner`, or a subpath export of it) or by a relative path
 * that climbs out of its own package (`../../runner/src/cell.ts`). Both spell
 * the same dependency, and the second is common enough here that ignoring it
 * would leave a hole. Which package a file or a specifier belongs to is decided
 * by the workspace member list rather than by the shape of the path, because
 * neither follows from the other. A member's directory name is not its package
 * name — `packages/connectors/agents/connector` publishes
 * `@commonfabric/agents-connector` — and a member can sit several directories
 * below `packages`, as that one does, so the longest matching member owns a
 * file rather than the first path segment.
 *
 * A type-only import counts. It disappears before the code runs, so it cannot
 * deadlock a module graph, but it still means one package's source cannot be
 * understood without the other's, which is the property this check is about.
 *
 * Matching is textual, so a package name inside a comment or a string reads as
 * an import. That can only invent an edge, never hide one: a false edge shows
 * up as a cycle that has to be explained, where a missed edge would let a real
 * one through unseen.
 *
 * Usage: deno run --allow-read --allow-run=git ./tasks/check-package-cycles.ts
 */

import { walk } from "@std/fs/walk";
import { parse as parseJsonc } from "@std/jsonc";
import { dirname, fromFileUrl, relative, resolve } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** A cycle that exists today and is not this check's job to fix. */
export interface AllowedCycle {
  /** Package directory names, sorted, exactly as the cycle stands today. */
  readonly packages: readonly string[];

  /** What the two sides take from each other. */
  readonly reason: string;
}

// The cycles this check found in the tree when it was written. Each is a real
// layering defect. Removing one is the point of the entry: break the cycle,
// delete the line, and this check confirms it is gone.
export const ALLOWLIST: readonly AllowedCycle[] = [
  {
    packages: ["memory", "runner"],
    reason:
      "memory's v2 query planner drives runner's schema traversal through " +
      "@commonfabric/runner/graph-query, and reaches runner's schema-document " +
      "registry, while runner's storage and ACL layers are written against " +
      "memory's interfaces and runner's traversal takes the shared scope_key " +
      "vocabulary (resolveScopeKey) from @commonfabric/memory/v2.",
  },
  {
    packages: ["html", "runtime-client"],
    reason: "html's main-thread applicator and debug helpers speak the " +
      "runtime-client protocol, while runtime-client's protocol types and " +
      "worker backend are defined in terms of html's VDOM operations.",
  },
];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);

// Directory names that mark everything below them as test code.
const TEST_DIRECTORIES = new Set(["test", "tests", "integration", "bench"]);

const SKIP_DIRS = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])vendor([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])coverage([\\/]|$)/,
];

// A module specifier is preceded by one of these: `from` for a static import or
// re-export, `import` alone for a side-effect import and, with a `(`, a dynamic
// one, `require(` for npm-style interop.
const SPECIFIER_LEAD =
  "(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)";
const SPECIFIER_PATTERN = new RegExp(
  `${SPECIFIER_LEAD}(["'\`])([^"'\`]+)\\1`,
  "g",
);

/** One import edge, kept with an example so a failure can name a file. */
export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly file: string;
  readonly specifier: string;
}

/** Every module specifier `source` imports, in order of appearance. */
export function extractSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER_PATTERN)].map((match) => match[2]);
}

/**
 * The workspace member holding a repo-relative path, as its directory under
 * `packages/`, or undefined for a path in no member.
 *
 * The longest matching member wins, because a member can sit several
 * directories below `packages`: `packages/connectors/agents/connector` is its
 * own package, and a file of its own is not a file of anything named
 * `connectors`.
 */
export function packageOfPath(
  path: string,
  members: readonly string[],
): string | undefined {
  let found: string | undefined;
  for (const dir of members) {
    if (!path.startsWith(`packages/${dir}/`)) continue;
    if (found === undefined || dir.length > found.length) found = dir;
  }
  return found;
}

/**
 * Reports whether a repo-relative path is production source of some member.
 * Everything under a package's test directories, and every file named for a
 * test or a benchmark, is excluded wherever it sits.
 */
export function isProductionSource(
  path: string,
  members: readonly string[],
): boolean {
  const dir = packageOfPath(path, members);
  if (dir === undefined) return false;
  const dot = path.lastIndexOf(".");
  if (dot === -1 || !CODE_EXTENSIONS.has(path.slice(dot))) return false;
  // Only the segments below the package decide this, so a member whose own
  // directory is named `test` does not exclude itself.
  const inside = path.slice(`packages/${dir}/`.length).split("/");
  const base = inside[inside.length - 1];
  if (/\.(test|bench)\.[^.]+$/.test(base)) return false;
  return !inside.slice(0, -1).some((s) => TEST_DIRECTORIES.has(s));
}

/**
 * Resolves a relative specifier against the directory holding `fromPath`,
 * returning a repo-relative path with `.` and `..` segments collapsed.
 */
export function resolveRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/** The workspace, as this check needs to see it. */
export interface Workspace {
  /** Every member's directory under `packages/`, which may itself be nested. */
  readonly members: readonly string[];

  /** Package name to member directory, for the members that declare a name. */
  readonly names: ReadonlyMap<string, string>;
}

/** Reads the workspace members named by the root config. */
export async function readWorkspace(root: string): Promise<Workspace> {
  const config = parseJsonc(
    await Deno.readTextFile(resolve(root, "deno.jsonc")),
  ) as { workspace?: unknown } | null;
  const listed = Array.isArray(config?.workspace) ? config.workspace : [];
  const members: string[] = [];
  // A member with no `name` is reachable only by relative path, which needs no
  // entry in the name map.
  const names = new Map<string, string>();
  for (const member of listed) {
    if (typeof member !== "string") continue;
    const dir = member.replace(/^\.\//, "");
    if (!dir.startsWith("packages/")) continue;
    const packageDir = dir.slice("packages/".length);
    members.push(packageDir);
    for (const file of ["deno.jsonc", "deno.json"]) {
      let text: string;
      try {
        text = await Deno.readTextFile(resolve(root, dir, file));
      } catch {
        continue;
      }
      const parsed = parseJsonc(text) as { name?: unknown } | null;
      if (typeof parsed?.name === "string") names.set(parsed.name, packageDir);
      break;
    }
  }
  return { members, names };
}

/** The package a specifier names, or undefined when it names none. */
export function targetPackage(
  fromPath: string,
  specifier: string,
  workspace: Workspace,
): string | undefined {
  if (specifier.startsWith(".")) {
    const resolved = resolveRelative(fromPath, specifier);
    return packageOfPath(resolved, workspace.members);
  }
  const parts = specifier.split("/");
  // Package names in this workspace are scoped, so the name is the first two
  // segments; an unscoped name would be the first.
  for (const length of [2, 1]) {
    const candidate = parts.slice(0, length).join("/");
    const dir = workspace.names.get(candidate);
    if (dir !== undefined) return dir;
  }
  return undefined;
}

// Repo-relative, forward-slash paths that git tracks under `root`, or null when
// `root` is not a git working tree (a unit-test fixture directory).
async function gitTrackedFiles(root: string): Promise<string[] | null> {
  let output;
  try {
    output = await new Deno.Command("git", {
      args: ["-C", root, "ls-files", "-z"],
      stdout: "piped",
      stderr: "null",
    }).output();
  } catch {
    return null; // git is not installed
  }
  if (!output.success) return null;
  const paths = new TextDecoder().decode(output.stdout)
    .split("\0").filter((path) => path !== "");
  return paths.length > 0 ? paths : null;
}

async function walkFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (
    const entry of walk(root, { includeDirs: false, skip: SKIP_DIRS })
  ) {
    paths.push(relative(root, entry.path).replaceAll("\\", "/"));
  }
  return paths;
}

/** Every import edge between two different packages' production source. */
export async function buildEdges(root: string): Promise<Edge[]> {
  const workspace = await readWorkspace(root);
  const paths = (await gitTrackedFiles(root) ?? await walkFiles(root))
    .filter((path) => isProductionSource(path, workspace.members));
  const edges: Edge[] = [];
  for (const path of paths) {
    const from = packageOfPath(path, workspace.members);
    if (from === undefined) continue;
    let source: string;
    try {
      source = await Deno.readTextFile(resolve(root, path));
    } catch {
      continue; // a tracked path that is not readable here, such as a symlink
    }
    for (const specifier of extractSpecifiers(source)) {
      const to = targetPackage(path, specifier, workspace);
      if (to === undefined || to === from) continue;
      edges.push({ from, to, file: path, specifier });
    }
  }
  return edges;
}

/**
 * Groups of packages that can each reach the other, sorted within each group
 * and between them. A package on its own is not a cycle and is not returned.
 */
export function findCycles(edges: readonly Edge[]): string[][] {
  const out = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!out.has(edge.from)) out.set(edge.from, new Set());
    out.get(edge.from)!.add(edge.to);
    if (!out.has(edge.to)) out.set(edge.to, new Set());
  }
  // Tarjan's strongly connected components, iterative so that a deep graph
  // cannot exhaust the stack.
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let nextIndex = 0;

  for (const root of out.keys()) {
    if (index.has(root)) continue;
    const work: { node: string; children: string[]; at: number }[] = [
      { node: root, children: [...out.get(root)!], at: 0 },
    ];
    index.set(root, nextIndex);
    lowLink.set(root, nextIndex);
    nextIndex++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.at < frame.children.length) {
        const child = frame.children[frame.at++];
        if (!index.has(child)) {
          index.set(child, nextIndex);
          lowLink.set(child, nextIndex);
          nextIndex++;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, children: [...out.get(child)!], at: 0 });
        } else if (onStack.has(child)) {
          lowLink.set(
            frame.node,
            Math.min(lowLink.get(frame.node)!, index.get(child)!),
          );
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowLink.set(
          parent.node,
          Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!),
        );
      }
      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const group: string[] = [];
        let popped: string;
        do {
          popped = stack.pop()!;
          onStack.delete(popped);
          group.push(popped);
        } while (popped !== frame.node);
        if (group.length > 1) groups.push(group.sort());
      }
    }
  }
  return groups.sort((a, b) => a[0].localeCompare(b[0]));
}

const key = (packages: readonly string[]) => [...packages].sort().join(" + ");

/** `1 cycle`, `2 cycles`. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Reports whether an allowlisted cycle already accounts for this edge, meaning
 * both of its endpoints sit inside one allowlist entry.
 */
export function isExcused(
  edge: Edge,
  allowlist: readonly AllowedCycle[],
): boolean {
  return allowlist.some((entry) =>
    entry.packages.includes(edge.from) && entry.packages.includes(edge.to)
  );
}

export interface ScanResult {
  /** Cycles present in the tree that the allowlist does not cover. */
  readonly unexpected: string[][];

  /** Allowlist entries that no longer describe a cycle in the tree. */
  readonly resolved: AllowedCycle[];

  readonly edges: readonly Edge[];
}

export async function scan(
  root: string,
  allowlist: readonly AllowedCycle[] = ALLOWLIST,
): Promise<ScanResult> {
  const edges = await buildEdges(root);
  const cycles = findCycles(edges);
  const allowed = new Set(allowlist.map((entry) => key(entry.packages)));
  const found = new Set(cycles.map(key));
  return {
    unexpected: cycles.filter((cycle) => !allowed.has(key(cycle))),
    resolved: allowlist.filter((entry) => !found.has(key(entry.packages))),
    edges,
  };
}

/** Reports whether every package in `nodes` can reach every other. */
export function isStronglyConnected(
  nodes: readonly string[],
  edges: readonly Edge[],
): boolean {
  if (nodes.length < 2) return false;
  const members = new Set(nodes);
  const reach = (forward: boolean): number => {
    const seen = new Set([nodes[0]]);
    const queue = [nodes[0]];
    while (queue.length > 0) {
      const at = queue.pop()!;
      for (const edge of edges) {
        const [tail, head] = forward
          ? [edge.from, edge.to]
          : [edge.to, edge.from];
        if (tail !== at || !members.has(head) || seen.has(head)) continue;
        seen.add(head);
        queue.push(head);
      }
    }
    return seen.size;
  };
  return reach(true) === members.size && reach(false) === members.size;
}

/** The edges of the cycle, grouped by the package pair they run between. */
function groupByPair(
  cycle: readonly string[],
  edges: readonly Edge[],
): Map<string, Edge[]> {
  const pairs = new Map<string, Edge[]>();
  for (const edge of edges) {
    if (!cycle.includes(edge.from) || !cycle.includes(edge.to)) continue;
    const pair = `${edge.from} -> ${edge.to}`;
    if (!pairs.has(pair)) pairs.set(pair, []);
    pairs.get(pair)!.push(edge);
  }
  return pairs;
}

// A cycle is reported through the package pairs that hold it together: those
// whose imports, taken away, would leave the group no longer able to reach
// itself. Listing every edge instead would bury them, because one new import
// can join several packages into a large group most of whose edges were
// already there and are not the thing to change. Pairs an allowlisted cycle
// already accounts for come last, and the thinnest pair comes first, an
// accidental dependency being the one used once rather than the one used
// thirty times.
function reportCycle(
  cycle: readonly string[],
  edges: readonly Edge[],
  allowlist: readonly AllowedCycle[],
): void {
  console.error(`  ${cycle.join(" + ")}`);
  const pairs = groupByPair(cycle, edges);
  const breaking = [...pairs].filter(([pair]) => {
    const kept = edges.filter((edge) => `${edge.from} -> ${edge.to}` !== pair);
    return !isStronglyConnected(cycle, kept);
  });
  const shown = (breaking.length > 0 ? breaking : [...pairs])
    .sort(([pairA, a], [pairB, b]) => {
      const excusedA = isExcused(a[0], allowlist) ? 1 : 0;
      const excusedB = isExcused(b[0], allowlist) ? 1 : 0;
      return excusedA - excusedB || a.length - b.length ||
        pairA.localeCompare(pairB);
    });
  console.error(
    breaking.length > 0
      ? "    Removing any one of these would break the cycle:"
      : "    No single pair holds the cycle together; its imports are:",
  );
  for (const [pair, examples] of shown) {
    console.error(`      ${pair}, ${count(examples.length, "import")}:`);
    for (const example of examples.slice(0, 3)) {
      console.error(`        ${example.file}  <-  ${example.specifier}`);
    }
  }
}

export async function main(
  root: string = REPO_ROOT,
  allowlist: readonly AllowedCycle[] = ALLOWLIST,
): Promise<number> {
  const { unexpected, resolved, edges } = await scan(root, allowlist);

  if (unexpected.length > 0) {
    console.error(
      `\n${count(unexpected.length, "package import cycle")} ` +
        "not on the allowlist:\n",
    );
    for (const cycle of unexpected) reportCycle(cycle, edges, allowlist);
    console.error(
      "\nBreak the cycle by moving the shared code to whichever side owns it," +
        "\njudged by what it touches rather than what it is named after. The" +
        "\nPace Layers section of AGENTS.md has the rule and a worked example.\n",
    );
    // The shrink check is not run here. A new import can absorb an allowlisted
    // cycle into a larger group, which leaves that entry matching nothing
    // through no fault of its own, and reporting it as fixed would send the
    // reader to the wrong file.
    return 1;
  }

  if (resolved.length > 0) {
    console.error(
      `\n${count(resolved.length, "ALLOWLIST entry", "ALLOWLIST entries")} ` +
        `in tasks/check-package-cycles.ts no longer ` +
        `${resolved.length === 1 ? "describes" : "describe"} a cycle:\n`,
    );
    for (const entry of resolved) {
      console.error(`  ${entry.packages.join(" + ")}`);
    }
    console.error(
      `\nThe allowlist may only shrink. Delete ` +
        `${resolved.length === 1 ? "it" : "them"}.\n`,
    );
    return 1;
  }

  console.log(
    allowlist.length === 0
      ? "Package imports are acyclic."
      : `Package imports are acyclic, ` +
        `apart from ${count(allowlist.length, "allowlisted cycle")}.`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main());

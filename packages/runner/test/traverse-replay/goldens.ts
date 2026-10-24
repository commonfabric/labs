/**
 * Golden-oracle storage and diffing for traverse replay fixtures.
 *
 * A golden is the serialized `ReplayOracle` for a fixture, generated from a
 * known-good baseline via `regen-goldens.ts`. The replay test asserts the
 * current code reproduces it exactly. A diff means traversal *semantics*
 * changed — results, the set of reads issued (scheduling surface), or
 * schema-tracker contents (server subscription surface). Optimizations must
 * keep goldens byte-identical; deliberate semantic changes regenerate them
 * (and the regenerated golden diff is the review artifact justifying the
 * change).
 */

import { fromFileUrl } from "@std/path";
import { readMaybeGzippedText, writeGzippedText } from "./gzip.ts";
import type { ReplayOracle } from "./replay.ts";

const fixturesDir = new URL("./fixtures/", import.meta.url);
const goldensDir = new URL("./goldens/", import.meta.url);

export function listFixturePaths(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const entry of Deno.readDirSync(fixturesDir)) {
    if (!entry.isFile) continue;
    const match = entry.name.match(/^(.*)\.json(\.gz)?$/);
    if (match === null) continue;
    out.push({
      name: match[1],
      path: fromFileUrl(new URL(entry.name, fixturesDir)),
    });
  }
  return out.sort((a, b) => a.name < b.name ? -1 : 1);
}

export function goldenPath(name: string): string {
  return fromFileUrl(new URL(`${name}.golden.json.gz`, goldensDir));
}

export async function loadGolden(
  name: string,
): Promise<ReplayOracle | undefined> {
  const path = goldenPath(name);
  try {
    Deno.statSync(path);
  } catch {
    return undefined;
  }
  return JSON.parse(await readMaybeGzippedText(path)) as ReplayOracle;
}

export async function writeGolden(
  name: string,
  oracle: ReplayOracle,
): Promise<void> {
  Deno.mkdirSync(goldensDir, { recursive: true });
  await writeGzippedText(goldenPath(name), JSON.stringify(oracle));
}

/** Human-oriented diff; empty array means the oracles match. */
export function diffOracles(
  expected: ReplayOracle,
  actual: ReplayOracle,
  maxExamples = 5,
): string[] {
  const problems: string[] = [];

  if (expected.invocations.length !== actual.invocations.length) {
    problems.push(
      `invocation count: expected ${expected.invocations.length}, ` +
        `actual ${actual.invocations.length}`,
    );
  }
  let shown = 0;
  const n = Math.min(expected.invocations.length, actual.invocations.length);
  for (let i = 0; i < n && shown < maxExamples; i++) {
    const e = expected.invocations[i];
    const a = actual.invocations[i];
    if (e.hash !== a.hash || e.ok !== a.ok || e.code !== a.code) {
      problems.push(
        `invocation ${i}: expected ` +
          `{ok:${e.ok},code:${e.code},hash:${e.hash}} got ` +
          `{ok:${a.ok},code:${a.code},hash:${a.hash}}`,
      );
      shown++;
    }
  }

  const expectedReads = new Set(expected.readSet);
  const actualReads = new Set(actual.readSet);
  const missing = expected.readSet.filter((r) => !actualReads.has(r));
  const extra = actual.readSet.filter((r) => !expectedReads.has(r));
  if (missing.length > 0) {
    problems.push(
      `${missing.length} reads missing (scheduling/invalidation surface ` +
        `shrank), e.g.:\n  ${missing.slice(0, maxExamples).join("\n  ")}`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `${extra.length} extra reads, e.g.:\n  ${
        extra.slice(0, maxExamples).join("\n  ")
      }`,
    );
  }

  const contextIds = new Set([
    ...Object.keys(expected.schemaTrackers),
    ...Object.keys(actual.schemaTrackers),
  ]);
  for (const id of [...contextIds].sort()) {
    const e = new Set(expected.schemaTrackers[id] ?? []);
    const a = new Set(actual.schemaTrackers[id] ?? []);
    const lost = [...e].filter((x) => !a.has(x));
    const gained = [...a].filter((x) => !e.has(x));
    if (lost.length > 0 || gained.length > 0) {
      problems.push(
        `schemaTracker context ${id}: -${lost.length} +${gained.length} ` +
          `entries, e.g.:\n  ${
            [...lost.slice(0, 2), ...gained.slice(0, 2)].join("\n  ")
          }`,
      );
    }
  }
  return problems;
}

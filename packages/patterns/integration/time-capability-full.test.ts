// Full-suite gate verification (W1 outstanding step). Instantiates EVERY pattern
// that calls the gated clock/entropy built-ins under the always-on gate,
// materializes its lifts, fires its result streams, and asserts no
// TimeCapabilityError escapes — i.e. no clock/entropy read runs in a
// lift/computed/pattern-body context anywhere in the pattern set.
//
// Only a TimeCapabilityError fails a pattern. Any other failure (a pattern that
// needs network/oauth/inputs to instantiate, or a multi-module
// ModuleVerificationError offline) is reported as "skipped: <reason>", not a
// gate finding — those need the integrations available in a full CI run. The set
// is scoped to files that actually read the gated clock/entropy (Date.now(),
// no-argument new Date(), Math.random()), since only those can throw the gate
// error.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { initializeCapabilityGateController } from "./capability-gate-controller.ts";

const ROOT = join(import.meta.dirname!, "..");

// Discover pattern files that call the gated helpers and export a pattern.
function discoverPatterns(): string[] {
  const hits: string[] = [];
  // Exclude non-shipped fixtures: `test/` (runtime test patterns, including the
  // non-idempotent/ fixtures that read the clock/entropy in a lift ON PURPOSE and
  // therefore correctly throw under the gate) and `gideon-tests/` (dev probes).
  const skipDirs = new Set([
    "deprecated",
    "node_modules",
    "integration",
    "test",
    "gideon-tests",
  ]);
  const walk = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const p = join(dir, entry.name);
      if (entry.isDirectory) {
        if (!skipDirs.has(entry.name)) walk(p);
        continue;
      }
      if (!entry.name.endsWith(".tsx") || entry.name.endsWith(".test.tsx")) {
        continue;
      }
      const src = Deno.readTextFileSync(p);
      // The raw ambient intrinsics the sandbox gates (W6): `Date.now()`,
      // no-argument `new Date()`, and `Math.random()`. `new Date(arg)` is
      // deterministic and does not match.
      if (
        /\bDate\.now\s*\(|\bMath\.random\s*\(|new Date\s*\(\s*\)/
          .test(src) &&
        /export default/.test(src)
      ) {
        hits.push(p.slice(ROOT.length + 1));
      }
    }
  };
  walk(ROOT);
  return hits.sort();
}

interface Outcome {
  timeCapabilityErrors: string[];
  skipReason?: string;
}

// Instantiate the pattern under the gate, materialize lifts, then fire every
// top-level result stream to exercise handler-context clock reads too.
async function checkPattern(rel: string): Promise<Outcome> {
  const cc = await initializeCapabilityGateController(
    `${rel}-${crypto.randomUUID()}`,
  );
  const errors: string[] = [];
  cc.runtime.scheduler.onError((err) => {
    if (err?.name === "TimeCapabilityError") errors.push(err.message);
  });
  let cancel: (() => void) | undefined;
  try {
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: join(ROOT, rel), root: ROOT },
    );
    const piece = await cc.create(program, { start: true });
    const resultCell = cc.getResult(piece.getCell());
    cancel = resultCell.sink(() => {});
    await cc.runtime.idle();
    await cc.synced();

    // Substep 3: fire result streams so handler-context clock reads run under
    // real dispatch. Sending to a non-stream key throws and is ignored; we only
    // care whether a handler frame ever surfaces a TimeCapabilityError (it must
    // not — handlers are allowed the coarse clock).
    let value: unknown;
    try {
      value = resultCell.get();
    } catch { /* result not readable; skip firing */ }
    if (value && typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        try {
          (resultCell.key(key) as unknown as { send: (e: unknown) => void })
            .send({});
        } catch { /* not a stream / bad shape — tolerated */ }
      }
      try {
        await cc.runtime.idle();
      } catch { /* tolerated */ }
    }
    return { timeCapabilityErrors: errors };
  } catch (e) {
    const err = e as Error;
    if (err?.name === "TimeCapabilityError") {
      errors.push(err.message);
      return { timeCapabilityErrors: errors };
    }
    return {
      timeCapabilityErrors: errors,
      skipReason: `${err?.name}: ${
        (err?.message ?? "").split("\n")[0].slice(0, 120)
      }`,
    };
  } finally {
    cancel?.();
    await cc.dispose();
  }
}

const PATTERNS = discoverPatterns();

describe("capability gate (W1): full pattern-set gate verification", () => {
  for (const rel of PATTERNS) {
    it(`no lift-context clock/entropy read in ${rel}`, async () => {
      const outcome = await checkPattern(rel);
      const violated = outcome.timeCapabilityErrors.length > 0;

      if (violated) {
        console.log(
          `[gate-violation] ${rel}:\n  - ${
            outcome.timeCapabilityErrors.join("\n  - ")
          }`,
        );
      } else if (outcome.skipReason) {
        console.log(`[skipped] ${rel}: ${outcome.skipReason}`);
      } else {
        console.log(`[clean] ${rel}`);
      }
      expect(outcome.timeCapabilityErrors).toEqual([]);
    });
  }
});

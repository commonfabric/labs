import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import { acceptedBreakKey } from "./pattern-compat-lib.ts";
import { patternPath, PATTERNS_DIR } from "./pattern-files.ts";
import { ACCEPTED_CONTRACT_BREAKS } from "./pattern-compat-accepted-breaks.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const BASELINES_DIR = join(REPO_ROOT, PATTERNS_DIR, "baselines");

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

describe("pattern-compat-accepted-breaks", () => {
  // The compatibility run reaches these entries only after compiling every
  // authored pattern, and it reads each one in the run that examined its
  // pattern. So the shape of an entry — a pattern that exists, a baseline that
  // exists, a pair named once, a path spelled the way the proof spells it — is
  // worth settling here, in milliseconds, against the files on disk.

  describe("ACCEPTED_CONTRACT_BREAKS", () => {
    it("names a pattern file that exists for every entry", async () => {
      for (const accepted of ACCEPTED_CONTRACT_BREAKS) {
        expect(
          await exists(join(REPO_ROOT, patternPath(accepted.pattern))),
          `${accepted.pattern} does not exist`,
        ).toBe(true);
      }
    });

    it("names a baseline file that exists for every forgiven pair", async () => {
      for (const accepted of ACCEPTED_CONTRACT_BREAKS) {
        expect(accepted.baselines.length).toBeGreaterThan(0);
        for (const baseline of accepted.baselines) {
          expect(
            await exists(
              join(BASELINES_DIR, accepted.pattern, `${baseline}.json`),
            ),
            `${accepted.pattern} has no baseline ${baseline}`,
          ).toBe(true);
        }
      }
    });

    it("names each pattern and baseline pair once", () => {
      // The run indexes entries into one map keyed by pattern and baseline, so
      // a pair named twice keeps only the later entry's paths and silently
      // drops the earlier one's.

      const seen = new Set<string>();
      const repeated: string[] = [];
      for (const accepted of ACCEPTED_CONTRACT_BREAKS) {
        for (const baseline of accepted.baselines) {
          const key = acceptedBreakKey(accepted.pattern, baseline);
          if (seen.has(key)) repeated.push(key);
          seen.add(key);
        }
      }
      expect(repeated).toEqual([]);
    });

    it("spells every path as an argument or result path", () => {
      // A finding is forgiven only when every path it blames is one the entry
      // named, and the proof spells a path as its role followed by the schema
      // pointer. A path under any other name forgives nothing.
      //
      // The role alone is one of those spellings. `schemaSubsetIssue` starts
      // at `"argument"` or `"result"` and appends `.<property>` on the way
      // down, so an issue found at the root of a schema — `ifc` on the schema
      // itself, rather than on any field of it — is reported as the bare role.
      // Requiring the dot would reject the only name that forgives such a
      // finding, and the entry would then forgive nothing while looking as
      // though it did.

      const roles = ["argument", "result"];
      for (const accepted of ACCEPTED_CONTRACT_BREAKS) {
        expect(accepted.paths.length).toBeGreaterThan(0);
        for (const path of accepted.paths) {
          expect(
            roles.some((role) => path === role || path.startsWith(`${role}.`)),
            `${accepted.pattern} names path ${path}`,
          ).toBe(true);
        }
      }
    });

    it("carries a reason for every entry", () => {
      for (const accepted of ACCEPTED_CONTRACT_BREAKS) {
        expect(accepted.reason.trim().length).toBeGreaterThan(0);
      }
    });
  });
});

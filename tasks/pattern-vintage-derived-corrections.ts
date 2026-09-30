/**
 * Approved corrections of stale derived state in an exact recorded fixture.
 *
 * The checksum seals the recorded input used to approve cache invalidation.
 * Every other fixture and every other finding keeps its ordinary grading.
 */

import { encodeHex } from "@std/encoding/hex";
import { exists } from "@std/fs";

import { sha256 } from "@commonfabric/content-hash";

import type {
  StateFinding,
  VintageManifestEntry,
} from "../packages/piece/test/state-continuity-harness.ts";
import { vintageCompanionDir } from "../packages/piece/test/vintage-layout.ts";
import type { VintageRef } from "./pattern-vintage-lib.ts";

const TEST_KEY = "lunch-poll/main.test.tsx";
const STAMP = "2026-07-30T21-32-46.548Z";
const IDENTITY = "vKpn8ERxJNomhrTLevYIZ5cL3qg_QKk73pMRtnPKJwM";
const DIGEST =
  "6eafc9fda5e4fb3fd904ddab215dad3834f6f6fb2f8be055cab258b2306dfff0";
const SPACE = "did:key:z6MkiP8m4ES1oC1PwNdjNDut2nXWP6TY2EJceCHmSdYUmoEm";
const ROOTS = [
  "of:fid1:nBd8WTpSRoVy0BNB2CKnWShQAhJJOS8pqYFHL45hI1U",
  "of:fid1:qLOvr9VSkYDzl-vOQ4t0ztIxXKSIhgPVwtBcD-fihXU",
];
const RECORD =
  "docs/history/development/2026-09-14-derived-state-correction.md";

/** One replay's correction accounting, bound to its verified input fixture. */
export interface DerivedCorrections {
  /** Grade only approved transitions as changes, retaining every finding. */
  grade(
    entry: VintageManifestEntry,
    findings: readonly StateFinding[],
  ): StateFinding[];

  /** Roots whose approved transition did not occur in this replay. */
  unused(): string[];
}

/**
 * Verify the exact input fixture and return its approved correction policy.
 * A companion store or different bytes require a separate decision.
 */
export async function derivedCorrectionsFor(
  vintage: VintageRef,
  repoRoot: string,
): Promise<DerivedCorrections | undefined> {
  if (
    vintage.testKey !== TEST_KEY || vintage.tier !== "pinned" ||
    vintage.stamp !== STAMP || vintage.identity !== IDENTITY
  ) return undefined;
  if (await exists(vintageCompanionDir(vintage.path))) return undefined;
  if (encodeHex(sha256(await Deno.readFile(vintage.path))) !== DIGEST) {
    return undefined;
  }
  if (!await exists(`${repoRoot}/${RECORD}`)) {
    throw new Error(`Missing derived-state correction decision: ${RECORD}`);
  }
  const unused = new Set(ROOTS);
  return {
    grade(entry, findings) {
      if (
        entry.space !== SPACE || !ROOTS.includes(entry.cellId) ||
        entry.main !== "/packages/patterns/lunch-poll/poll-option-card.tsx" ||
        entry.symbol !== "default" ||
        entry.identity !== "iJLndA3hnQHY1W_revxrP3ENer9VYf2tIFNCOjoPV6Y"
      ) return [...findings];
      return findings.map((finding) => {
        if (
          finding.key !== "artSyncState" || !finding.lost ||
          finding.before !== "generated" || finding.after !== ""
        ) return finding;
        unused.delete(entry.cellId);
        console.warn(
          `  ! approved derived-state correction: ${entry.cellId} ` +
            `artSyncState: generated → empty; decision: ${RECORD}`,
        );
        return { ...finding, lost: false };
      });
    },
    unused: () => [...unused],
  };
}

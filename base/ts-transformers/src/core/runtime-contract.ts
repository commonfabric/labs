/**
 * The transformer↔runtime contract surface that the RUNTIME needs at boot:
 * values the runner reads while evaluating already-compiled patterns, with no
 * compilation in sight. This module must stay free of `typescript` (and other
 * compiler-stack) value imports — the runtime worker imports it eagerly, and a
 * value edge here would pull the whole compiler into every worker spawn (see
 * the runner's compiler-stack module).
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * Name of the sandbox global the pattern-coverage transformer emits probe
 * calls against; the engine installs a collector under this name when
 * coverage is enabled.
 */
export const PATTERN_COVERAGE_GLOBAL = "__cfPatternCoverage";

/** Portable compiler output; trusted ingestion performs the semantic checks. */
export interface CfcPolicyCompilerManifestV1 {
  readonly policyDigest: string;
  readonly manifest: {
    readonly formatVersion: 1;
    readonly moduleIdentity: string;
    readonly symbol: string;
    readonly template: {
      readonly templateVersion: 1;
      readonly exchangeRules: readonly unknown[];
      readonly dependencies: {
        readonly authorityOnly: readonly string[];
        readonly dataBearing: readonly string[];
      };
      readonly integrityRequirements: Readonly<Record<string, unknown>>;
    };
  };
}

/** Authored location of one function-bearing builder artifact. */
export interface BuilderSourceSite {
  /** Authored line, 1-based. */
  readonly line: number;

  /** Authored column, 0-based. */
  readonly col: number;

  /** Declaration name visible in authored source, when one exists. */
  readonly bindingName?: string;
}

/**
 * Debug-only compiler output mapping runtime artifact symbols to authored
 * locations. It travels beside emitted JavaScript and is never executable.
 */
export interface BuilderSourceSitesV1 {
  readonly formatVersion: 1;
  readonly sites: Readonly<Record<string, BuilderSourceSite>>;
}

/** Returns whether `value` is a well-formed builder-source-site sidecar. */
export function isBuilderSourceSitesV1(
  value: unknown,
): value is BuilderSourceSitesV1 {
  if (!isRecord(value) || value.formatVersion !== 1) return false;
  if (!isRecord(value.sites)) return false;
  for (const [symbol, site] of Object.entries(value.sites)) {
    if (symbol.length === 0 || !isRecord(site)) return false;
    if (!isIntegerAtLeast(site.line, 1) || !isIntegerAtLeast(site.col, 0)) {
      return false;
    }
    if (
      site.bindingName !== undefined &&
      (typeof site.bindingName !== "string" || site.bindingName.length === 0)
    ) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObjectNotArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= minimum;
}

/** Index of the first non-blank line, or null for an all-blank source. */
export function findFirstContentLineIndex(
  lines: readonly string[],
): number | null {
  for (const [index, line] of lines.entries()) {
    if (line.trim().length > 0) {
      return index;
    }
  }
  return null;
}

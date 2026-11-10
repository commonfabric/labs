/** Build identities are provenance, never a compatibility decision. */
export interface PeerBuildDiagnostics {
  local: string | undefined;
  peer: string | undefined;
  relation: "same" | "different" | "unknown";
}

declare global {
  var $COMMIT_SHA: string | undefined;
}

/** Ignore absent or malformed optional diagnostic metadata. */
export function normalizeBuildMarker(
  value: string | null | undefined,
): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
    ? value
    : undefined;
}

/** Captured bundler define; source runs have no baked provenance. */
export const bundledBuild = normalizeBuildMarker(
  typeof $COMMIT_SHA === "string" ? $COMMIT_SHA : undefined,
);

/** Compare provenance without inferring whether the peers can communicate. */
export function comparePeerBuilds(
  local: string | null | undefined,
  peer: string | null | undefined,
): PeerBuildDiagnostics {
  const ours = normalizeBuildMarker(local);
  const theirs = normalizeBuildMarker(peer);
  return {
    local: ours,
    peer: theirs,
    relation: ours === undefined || theirs === undefined
      ? "unknown"
      : ours === theirs
      ? "same"
      : "different",
  };
}

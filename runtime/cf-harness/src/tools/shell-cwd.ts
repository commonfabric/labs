export interface FinalWorkingDirectoryParseResult {
  stdout: string;
  cwd?: string;
}

export const cwdMarkerForOutput = (
  markerPrefix: string,
  outputId: string,
): string => `${markerPrefix}${outputId}__`;

export const commandWithFinalWorkingDirectoryMarker = (
  command: string,
  cwdMarker: string,
): string =>
  [
    `__cf_harness_cwd_marker=${JSON.stringify(cwdMarker)}`,
    'trap \'__cf_harness_status=$?; trap - EXIT; { printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)" || true; }; exit "$__cf_harness_status"\' EXIT',
    command,
  ].join("\n");

export const extractFinalWorkingDirectory = (
  stdout: string,
  marker: string,
): FinalWorkingDirectoryParseResult => {
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) {
    return { stdout };
  }
  return {
    stdout: stdout.slice(0, markerIndex),
    cwd: stdout.slice(markerIndex + marker.length),
  };
};

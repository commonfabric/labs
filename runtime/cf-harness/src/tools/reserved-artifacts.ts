import type { HarnessToolContext } from "./types.ts";

export const RESERVED_ARTIFACT_PATH_DETAIL =
  "cf-harness artifact paths are reserved from model-facing tools";

export const isResolvedPathInsideArtifactRoot = async (
  context: HarnessToolContext,
  resolvedPath: string,
): Promise<boolean> => {
  try {
    return await context.isHostPathWithinArtifactRoot(
      context.resolveHostPath(resolvedPath),
      { allowMissing: true },
    );
  } catch {
    return false;
  }
};

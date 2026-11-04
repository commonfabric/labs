const DEFAULT_HOST_PATH =
  "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const readHostPath = (): string => {
  try {
    return Deno.env.get("PATH") ?? DEFAULT_HOST_PATH;
  } catch (error) {
    if (
      error instanceof Deno.errors.PermissionDenied ||
      (error instanceof Error && error.name === "NotCapable")
    ) {
      return DEFAULT_HOST_PATH;
    }
    throw error;
  }
};

export const createClearedHostProcessEnv = (
  env: Record<string, string> = {},
): Record<string, string> => ({
  PATH: readHostPath(),
  ...env,
});

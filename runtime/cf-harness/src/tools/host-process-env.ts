const DEFAULT_HOST_PATH =
  "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const readHostPath = (): string => {
  try {
    return Deno.env.get("PATH") ?? DEFAULT_HOST_PATH;
  } catch {
    // Reading a valid variable name fails only when env access is denied.
    return DEFAULT_HOST_PATH;
  }
};

export const createClearedHostProcessEnv = (
  env: Record<string, string> = {},
): Record<string, string> => ({
  PATH: readHostPath(),
  ...env,
});

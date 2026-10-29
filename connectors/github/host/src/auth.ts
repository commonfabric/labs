export type GithubTokenCommand = () => Promise<{
  code: number;
  stdout: string;
  stderr: string;
}>;

const runGhAuthToken: GithubTokenCommand = async () => {
  const output = await new Deno.Command("gh", {
    args: ["auth", "token"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

/** Resolve a GitHub token without storing it in Fabric or on disk. */
export async function resolveGithubToken(
  readEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
  runCommand: GithubTokenCommand = runGhAuthToken,
): Promise<string> {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = readEnv(name)?.trim();
    if (value) return value;
  }
  let result: Awaited<ReturnType<GithubTokenCommand>>;
  try {
    result = await runCommand();
  } catch (error) {
    throw new Error(
      "GitHub authentication requires GH_TOKEN, GITHUB_TOKEN, or the gh CLI",
      { cause: error },
    );
  }
  const token = result.stdout.trim();
  if (result.code !== 0 || !token) {
    const detail = result.stderr.trim().split("\n")[0];
    throw new Error(
      `gh auth token failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return token;
}

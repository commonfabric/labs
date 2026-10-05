/**
 * Guard against the one way a correct completion script still does nothing.
 *
 * The emitted function calls `cf completion complete` *by name* on every Tab,
 * and discards that command's errors so a failing completion can never paste
 * text into the user's command line. Those two facts compose badly: with no
 * `cf` on PATH, every Tab silently yields zero candidates, and the script the
 * user just installed looks like it simply does not work. The `deno` binding
 * inherits the same fate, so `deno task cf <TAB>` — the invocation most people
 * actually type — is dead too.
 *
 * CI already resolves `cf` by name — `packages/cli/integration/integration.sh`
 * runs `command cf`, and a lane's `cf` capability puts the checkout's `bin/`
 * first on PATH — but it constructs that PATH itself, and local runs of the
 * same scripts set `CF_CLI_INTEGRATION_USE_LOCAL` to force the source CLI
 * instead. Completion is therefore the first thing to require `cf` on PATH on
 * a *developer's own machine*, where nothing sets it up. This check makes that
 * requirement legible when the script is generated rather than at some later
 * Tab press.
 */

/** Injectable filesystem probe, so the lookup is testable without a PATH. */
export interface PathProbe {
  (path: string): { isFile: boolean; mode: number | null } | undefined;
}

export interface ResolveOptions {
  readonly path?: string | undefined;
  readonly separator?: string;
  readonly probe?: PathProbe;
}

const defaultProbe: PathProbe = (path) => {
  try {
    const info = Deno.statSync(path);
    return { isFile: info.isFile, mode: info.mode };
  } catch {
    return undefined;
  }
};

/**
 * Whether `name` resolves to an executable file on PATH.
 *
 * `mode` is null on filesystems that do not report it, in which case an
 * existing file is accepted: a false "installed" is a missing warning, while a
 * false "missing" is a confusing warning on a working setup.
 */
export function resolvesOnPath(
  name: string,
  options: ResolveOptions = {},
): boolean {
  const separator = options.separator ??
    (Deno.build.os === "windows" ? ";" : ":");
  const path = options.path ?? Deno.env.get("PATH") ?? "";
  const probe = options.probe ?? defaultProbe;

  for (const directory of path.split(separator)) {
    if (directory === "") continue;
    const info = probe(`${directory.replace(/\/+$/, "")}/${name}`);
    if (info?.isFile && (info.mode === null || (info.mode & 0o111) !== 0)) {
      return true;
    }
  }
  return false;
}

/**
 * The stderr warning shown when the script is generated without `name` on
 * PATH. Deliberately not thrown: the script itself is correct and printing it
 * to a redirect must keep working, so this informs without failing.
 */
export function missingCommandWarning(name: string): string {
  // `$PWD` rather than a resolved root: the documented way to reach this
  // command is from the checkout, and a literal the user can paste beats a
  // path that would be wrong for a compiled binary run from elsewhere.
  const link = `ln -s "$PWD/bin/${name}" ~/.local/bin/${name}`;
  return [
    `warning: '${name}' is not on your PATH, so this completion script will`,
    `         silently do nothing — it calls '${name} completion complete' on`,
    `         every Tab, and that failure is swallowed by design.`,
    ``,
    `  Put one there once: deno task install-cf`,
    `  or by hand:         ${link}`,
    ``,
    `  See "Installing ${name} on PATH" in packages/cli/README.md.`,
  ].join("\n");
}

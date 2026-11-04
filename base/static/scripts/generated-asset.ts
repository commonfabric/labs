/**
 * The command line shared by the scripts that build a checked-in asset from a
 * source module in the workspace. Each such script says what its asset is and
 * how to produce its text; this module turns that into a program which either
 * rewrites the file or reports whether the checked-in copy is current.
 */

/** A checked-in file built from workspace sources. */
export interface GeneratedAsset {
  /** Absolute path of the file to write. */
  readonly target: string;

  /** Task line that rewrites it, as run from `base/static`. */
  readonly genTask: string;

  /** Produces the file's complete text, header included. */
  generate(): Promise<string> | string;
}

/**
 * Runs the command-line interface and returns the process exit code. With
 * `--check` it reports whether the file at `target` already matches the
 * generated output; otherwise it rewrites that file.
 */
export async function runCli(
  args: string[],
  asset: GeneratedAsset,
  target: string = asset.target,
): Promise<number> {
  const check = args.includes("--check");
  const generated = await asset.generate();

  if (check) {
    let existing = "";
    try {
      existing = await Deno.readTextFile(target);
    } catch {
      existing = "";
    }
    if (existing !== generated) {
      console.error(
        `${target} is out of date. Run \`${asset.genTask}\` to regenerate it.`,
      );
      return 1;
    }
    console.log(`${target} is up to date.`);
    return 0;
  }

  await Deno.writeTextFile(target, generated);
  console.log(`Wrote ${target}`);
  return 0;
}

/**
 * Entry point: runs the CLI and exits with its status, but only when the
 * calling module is the program's entry point. `isMain` is a parameter rather
 * than a default because `import.meta.main` answers for the module that reads
 * it, which here would always be this one. `exit` is injectable so the entry
 * behavior can be exercised without terminating the test runner.
 */
export async function cliMain(
  asset: GeneratedAsset,
  args: string[],
  isMain: boolean,
  exit: (code: number) => void = Deno.exit,
): Promise<void> {
  if (!isMain) return;
  exit(await runCli(args, asset));
}

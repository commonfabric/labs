// deno-lint-ignore-file cf-imports/no-inline-module-import -- each test drives
// its own copy of the command tree, which reads the environment as it is built;
// the query string is what makes the copy.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { test as testCommand } from "../commands/test-command.ts";
import { cf, checkStderr, stripAnsi, withEnv } from "./utils.ts";
import { COMMAND_SPELLING_END_DATE } from "../lib/deprecated-spelling.ts";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`Deno.exit(${code})`);
  }
}

async function withMockExit(
  callback: () => Promise<void>,
): Promise<number | null> {
  const originalExit = Deno.exit;
  Deno.exit = ((code?: number): never => {
    throw new ExitError(code ?? 0);
  }) as typeof Deno.exit;

  try {
    await callback();
    return null;
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  } finally {
    Deno.exit = originalExit;
  }
}

async function withCapturedErrors(
  callback: () => Promise<void>,
): Promise<string[]> {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  try {
    await callback();
  } finally {
    console.error = originalError;
  }

  return errors;
}

describe("main command", () => {
  it("mounts the interactive shell at `sh`, and at no name spelling `shell`", async () => {
    // Two claims, and the second is the reason for the first: `shell` names
    // the web frontend, and the shuttle design commits to adding no second
    // meaning to a word that already carries one
    // (`docs/plans/shuttle/README.md`, decision 19).

    const { main } = await import("../commands/main.ts?shell-mount-test");
    const names = main.getCommands(true).map((command: { getName(): string }) =>
      command.getName()
    );
    expect(names).toContain("sh");
    expect(names).not.toContain("shell");
  });

  it("keeps command usage aligned with accepted positional syntax", async () => {
    const { main } = await import(
      "../commands/main.ts?main-command-usage-test"
    );
    const commands = [main];
    const mismatchedUsage: string[] = [];
    // Commands that state their own usage because what they accept is not
    // expressible as a Cliffy positional: both mounts of `call`, for the
    // callable section, and the invitation commands, which also take the ID
    // as the word after `--`. Written out rather than derived: this set had
    // held one name twice, so the exemption it was meant to carry had
    // silently lapsed.
    const customUsageCommands = new Set([
      "cf piece call",
      "cf call",
      "cf space invite redeem",
      "cf space invite revoke",
      "cf space invite receipts",
    ]);

    for (const command of commands) {
      commands.push(...command.getCommands());
      if (customUsageCommands.has(command.getPath())) continue;

      const typedArguments = command.getArgsDefinition();
      if (!typedArguments) continue;

      const untypedArguments = typedArguments.replaceAll(/:[^>\]]+/g, "");
      const usage = command.getUsage();
      const expectedArguments = [typedArguments, untypedArguments];
      const matches = expectedArguments.some((expected) =>
        usage.endsWith(expected)
      );
      if (!matches) {
        mismatchedUsage.push(
          `${command.getPath()}: expected usage to end with ${
            expectedArguments.join(" or ")
          }, got ${usage}`,
        );
      }
    }

    expect(mismatchedUsage).toEqual([]);
  });

  it("tells a caller what a same-id retry costs, on every waiting flag", async () => {
    // Both waiting flags invite a retry, and a retry runs the handler body
    // again — at-most-once is per commit, not per execution. `--wait` is the
    // sharper case: an expiry is exactly when the caller cannot tell whether
    // the handling committed. The two sit adjacent in `--help`, so a caveat
    // on one and silence on the other reads as a real difference between
    // them.
    const { code, stdout, stderr } = await cf("piece call --help");
    checkStderr(stderr);
    const help = stripAnsi(stdout.join("\n")).replaceAll(/\s+/g, " ");
    expect(help).toContain(
      "Re-invoking under the same id and session cannot commit twice — but " +
        "it runs the handler body again",
    );
    expect(help).toContain(
      "recovers it too, but runs the handler body again",
    );
    expect(code).toBe(0);
  });

  it("describes and parses piece call's accepted input forms", async () => {
    const { pieceDataCommand } = await import(
      "../commands/piece.ts?piece-call-usage-test"
    );
    const call = pieceDataCommand("call", { spelling: "piece call" });
    const expectedUsage =
      "--identity <identity> --url <url> --api-url <api-url> --space <space> " +
      "--cell <cell> [address] <callable> [input]";

    expect(call.getArgsDefinition()).toBe(
      "<callable:string> [tail...:string]",
    );
    expect(call.getUsage()).toBe(expectedUsage);
    const { code, stdout, stderr } = await cf("piece call --help");
    checkStderr(stderr);
    const help = stripAnsi(stdout.join("\n"));
    const renderedUsage = help.split("\n").find((line) =>
      line.trimStart().startsWith("Usage:")
    );
    expect(renderedUsage?.replaceAll(/\s+/g, " ").trim()).toBe(
      `Usage: cf piece call ${expectedUsage}`,
    );
    const normalizedHelp = help.replaceAll(/\s+/g, " ");
    expect(normalizedHelp).toContain(
      `The callable name opens the callable's section and "--" closes it: piece-call options come before the name, the callable's own arguments after it, and the read options (--select, --schema, --filter) past the marker. Arguments in the section use the same parser as cf exec. Use --json with an optional inline value for complete JSON input; bare --json reads JSON from stdin. A single positional JSON value or "-" stdin sentinel is also accepted. Use --help --json for machine-readable schema help. Handlers interpret piped input when no input argument is present.`,
    );
    expect(code).toBe(0);

    const parsedCalls: Array<{
      positionals: unknown[];
      literalArguments: string[];
    }> = [];
    call.action(function (_options, ...positionals) {
      parsedCalls.push({
        positionals,
        literalArguments: this.getLiteralArgs(),
      });
    });
    await call.parse(["search", '{"query":"tea"}']);
    await call.parse(["search", "--help"]);
    await call.parse(["search", "-"]);
    await call.parse(["search", "--query", "milk"]);
    await call.parse(["search", "--", "--select", "id"]);
    expect(parsedCalls).toEqual([
      {
        positionals: ["search", '{"query":"tea"}'],
        literalArguments: [],
      },
      { positionals: ["search", "--help"], literalArguments: [] },
      { positionals: ["search", "-"], literalArguments: [] },
      // The verb opened the section, so its own flags are positionals of
      // this command and the marker sets nothing aside.
      {
        positionals: ["search", "--query", "milk"],
        literalArguments: [],
      },
      // And the marker is what hands the read step its words.
      { positionals: ["search"], literalArguments: ["--select", "id"] },
    ]);
  });

  it("reads piece call's invocation session from `CF_INVOCATION_SESSION`, behind `--invocation-session`", async () => {
    const { pieceDataCommand } = await import(
      "../commands/piece.ts?piece-call-session-test"
    );
    const call = pieceDataCommand("call");
    const sessions: Array<string | undefined> = [];
    call.action((options: { invocationSession?: string }) => {
      sessions.push(options.invocationSession);
    });

    await withEnv("CF_INVOCATION_SESSION", "from-env", async () => {
      await call.parse([
        "--invocation-session",
        "from-flag",
        "increment",
      ]);
      await call.parse(["increment"]);
    });
    await withEnv("CF_INVOCATION_SESSION", undefined, async () => {
      await call.parse(["increment"]);
    });

    // The environment is the standing default for a shell or an agent run,
    // and the flag is the one call that departs from it — so the flag wins.
    // With neither, the option arrives `undefined`: this is the option layer
    // alone, and `resolveInvocationIdentity` is what goes on to mint a
    // session for a caller that named none.
    //
    // The middle reading is the one that pins the env var to this option:
    // the variable is declared under the `CF_` prefix, and what reaches
    // `.invocationSession` is the remainder camel-cased. A name whose
    // remainder camel-cases to anything else would leave that reading
    // `undefined` while the flag readings stayed green.
    expect(sessions).toEqual(["from-flag", "from-env", undefined]);
  });

  it("refuses a projection before the verb on piece call", async () => {
    // Refused on the argv alone, before a piece is resolved or a request
    // sent: the api-url below is never reached. Two inline payloads are the
    // other shape, and they are NOT refused here — they belong to the
    // callable's section, so its own parser is what names them.
    const { main } = await import(
      "../commands/main.ts?piece-call-inline-validation-test"
    );
    await expect(
      main.parse([
        "call",
        "--identity",
        "./identity.key",
        "--api-url",
        "https://cf.dev",
        "--space",
        "common-knowledge",
        "--piece",
        "abcdefghijklmnopqrstuvwxyz",
        "--select",
        "id",
        "search",
        '{"query":"tea"}',
      ]),
    ).rejects.toThrow(/--select shapes the result/);
  });

  it("mounts each data command under the noun it acts on", async () => {
    // Both halves matter and only one is observable as a presence: the
    // superseded spellings still resolve, so a test that only looked for the
    // blessed ones would pass with the surface unchanged.
    const { main } = await import(
      "../commands/main.ts?piece-data-absence"
    );
    const named = (
      // deno-lint-ignore no-explicit-any
      command: any,
      includeHidden: boolean,
    ): string[] =>
      command.getCommands(includeHidden).map((c: { getName(): string }) =>
        c.getName()
      );
    const childOf = (name: string) =>
      // deno-lint-ignore no-explicit-any
      main.getCommands(true).find((c: any) => c.getName() === name);

    const cell = childOf("cell");
    expect(cell).toBeDefined();
    expect(named(cell, false).sort()).toEqual(
      ["get", "get-label", "help", "set", "set-label"],
    );

    const piece = childOf("piece");
    expect(piece).toBeDefined();
    expect(named(piece, false)).toContain("call");
    // The lifecycle commands that merely start with the same word stay put.
    expect(named(piece, false)).toContain("setsrc");
    expect(named(piece, false)).toContain("getsrc");
    // The label commands act on a cell and moved with `get` and `set`.
    expect(named(piece, false)).not.toContain("get-label");
    expect(named(piece, false)).not.toContain("set-label");

    // The superseded top-level spellings resolve and are offered to nobody.
    for (const superseded of ["get", "set", "call"]) {
      expect(named(main, true)).toContain(superseded);
      expect(named(main, false)).not.toContain(superseded);
    }
  });

  it("carries the migration notice on a superseded spelling's help page", async () => {
    // The page is where a caller learning a command looks, and a superseded
    // mount's page teaches its own spelling in every example. `--help` exits
    // before any action runs, so the notice cannot ride the action alone.
    //
    // Both halves are asserted together: the notice on the superseded page,
    // and silence on the blessed one. A notice fired from the shared builder
    // rather than from the mount would put it on both, and a test that only
    // read the superseded page would call that a pass.
    for (
      const [superseded, blessed] of [
        ["get", "cell get"],
        ["set", "cell set"],
        ["call", "piece call"],
        ["piece get-label", "cell get-label"],
        ["piece set-label", "cell set-label"],
        ["piece recreate-root", "space recreate-root"],
        ["piece set-home", "space set-home"],
      ] as const
    ) {
      const old = await cf(`${superseded} --help`);
      expect(old.code, superseded).toBe(0);
      // One line, on stderr, naming both spellings and the date. Asserted on
      // stderr because the page itself is stdout: a notice written there
      // would corrupt the machine-readable output these commands reserve it
      // for.
      expect(old.stderr.join("\n"), superseded).toContain(
        `'cf ${superseded}' is deprecated; spell it 'cf ${blessed}'.`,
      );
      expect(old.stderr.join("\n"), superseded).toContain(
        COMMAND_SPELLING_END_DATE,
      );
      expect(old.stdout.join("\n"), superseded).not.toContain("is deprecated");

      const current = await cf(`${blessed} --help`);
      expect(current.code, blessed).toBe(0);
      checkStderr(current.stderr);
      expect(current.stderr.join("\n"), blessed).not.toContain(
        "is deprecated",
      );
    }
  });

  it("says nothing on a line refused before the command is reached", async () => {
    // The boundary of the claim the README makes, pinned because it is the
    // one a reader can disprove. `--bogus` is refused in argument parsing, so
    // neither the action nor a help page runs on a read that reserves stdout:
    // its own error handler keeps the page off the stream it reserves.
    //
    // `set` reserves nothing, so the same refusal prints a page and the notice
    // rides it. Both are asserted, because a test that read only the silent
    // half would pass with the notice removed altogether.
    const reserved = await cf("get --bogus");
    expect(reserved.code).toBe(2);
    expect(reserved.stderr.join("\n")).toContain('Unknown option "--bogus"');
    expect(reserved.stderr.join("\n")).not.toContain("is deprecated");
    expect(reserved.stdout).toEqual([]);

    const unreserved = await cf("set --bogus");
    expect(unreserved.code).toBe(2);
    expect(unreserved.stderr.join("\n")).toContain(
      "'cf set' is deprecated; spell it 'cf cell set'.",
    );
  });

  it("registers visible commands and reports configured environment defaults", async () => {
    await withEnv("CF_IDENTITY", "./identity.key", async () => {
      await withEnv("CF_API_URL", "http://127.0.0.1:8000", async () => {
        await withEnv("CF_SPACE", "ambient", async () => {
          const { main } = await import(
            "../commands/main.ts?main-command-test"
          );

          const commandNames = main.getCommands().map((command) =>
            command.getName()
          );
          expect(commandNames).toContain("view");
          // A command that is not registered is invisible: `cf ingest` would
          // simply not exist, with no error anywhere to say why.
          expect(commandNames).toContain("ingest");
          expect(commandNames).toContain("fuse-daemon");
          expect(commandNames).toContain("fuse-supervisor");
          expect(commandNames).not.toContain("dev");
          expect(commandNames).not.toContain("deploy");

          const allCommandNames = main.getCommands(true).map((command) =>
            command.getName()
          );
          expect(allCommandNames).not.toContain("dev");
          expect(allCommandNames).not.toContain("deploy");
          main.getHelp();

          const description = main.getDescription();
          expect(description).toContain("ENVIRONMENT:");
          expect(description).toContain(
            "CF_IDENTITY = ./identity.key (set, no need to pass --identity)",
          );
          expect(description).toContain(
            "CF_API_URL  = http://127.0.0.1:8000 (set, no need to pass --api-url)",
          );

          // The CF_SPACE line promises "no need to pass --space" per
          // command, so every name on it has to be one the variable actually
          // reaches. Read back off the rendered line rather than restated
          // here: a list restated in the test is a list that agrees with
          // itself while disagreeing with the CLI.
          //
          // What a name has to earn differs by what it claims, so the check
          // does too. A noun claims its whole subtree, and the most a noun
          // can promise structurally is that every subcommand takes the
          // option — so that is what is asked of it. A name written as one
          // command is written that way because its noun could not be
          // promised, so the structural answer is already known to be no and
          // asking it again proves nothing: those are driven instead, and
          // must refuse for want of a space when the variable is absent.
          //
          // Declaring the option is not reading it. `space set-home` takes
          // `--space` through the shared target flags and acts on the
          // identity's own home space regardless, so it satisfies every
          // structural check and belongs on no list of what the variable
          // serves. That is the failure this shape exists to catch.
          const spaceLine = description.split("\n").find((text: string) =>
            text.includes("CF_SPACE    = ambient")
          );
          expect(spaceLine).toBeDefined();
          const named = spaceLine!
            .replace(/^.*no need to pass --space on /, "")
            .replace(/\)\s*$/, "")
            .split(", ")
            .map((entry) => entry.trim());
          expect(named.length).toBeGreaterThan(0);

          // deno-lint-ignore no-explicit-any
          const declaresSpace = (command: any): boolean =>
            // deno-lint-ignore no-explicit-any
            command.getEnvVars(true).some((envVar: any) =>
              envVar.names.includes("CF_SPACE")
            );

          for (const entry of named) {
            if (entry.includes(" ")) continue;
            const noun = main.getCommands(true).find((
              child: { getName(): string },
            ) => child.getName() === entry);
            expect(noun, entry).toBeDefined();
            if (declaresSpace(noun)) continue;
            // deno-lint-ignore no-explicit-any
            const children = (noun as any).getCommands(true).filter((
              child: { getName(): string },
            ) => child.getName() !== "help");
            expect(children.length, entry).toBeGreaterThan(0);
            for (const child of children) {
              expect(declaresSpace(child), `${entry} ${child.getName()}`)
                .toBe(true);
            }
          }

          // The identity and api-url are supplied so the run reaches the
          // space, and are deliberately not valid: what is read back is which
          // option the refusal names, and nothing here should get far enough
          // to open a key file.
          const reachesSpace = {
            CF_IDENTITY: "/nonexistent/identity.key",
            CF_API_URL: "http://127.0.0.1:8000",
          };
          for (const entry of named) {
            if (!entry.includes(" ")) continue;
            const absent = await cf(entry, { env: reachesSpace });
            expect(stripAnsi(absent.stderr.join("\n")), entry).toContain(
              'Missing required option: "--space"',
            );
            const ambient = await cf(entry, {
              env: { ...reachesSpace, CF_SPACE: "ambient" },
            });
            expect(stripAnsi(ambient.stderr.join("\n")), entry).not.toContain(
              'Missing required option: "--space"',
            );
          }
        });
      });
    });
  });

  it("refuses --list beside the target flag, under either of its names", async () => {
    // The conflict names the option's Cliffy key, and both spellings share
    // one. A stale key here is silent: the command runs, the list selector
    // wins, and a repair --apply mutates a target the line does not name.
    for (const flag of ["--cell", "--piece"]) {
      for (const command of ["piece survey", "piece repair"]) {
        const where = `${command} ${flag}`;
        const { code, stderr } = await cf(
          `${command} ${flag} holder --list member`,
        );
        // The whole command line is echoed to stderr, so a looser assertion
        // here passes whether or not the conflict fires. Name the refusal.
        expect(stripAnsi(stderr.join("\n")), where).toContain(
          'Option "--list" conflicts with option "--cell".',
        );
        expect(code, where).toBe(2);
      }
    }
  });

  it("shows exec command help before trying to resolve a mounted file", async () => {
    const { code, stdout } = await cf("exec --help");
    const help = stripAnsi(stdout.join("\n"));

    expect(code).toBe(0);
    expect(help).toContain(
      "Execute a mounted callable file from a Common Fabric FUSE mount.",
    );
    expect(help).not.toContain("not within a mounted cf fuse");
  });

  it("shows help for the direct FUSE daemon entry point", async () => {
    const { code, stdout } = await cf("fuse-daemon --help");

    expect(code).toBe(0);
    expect(stripAnsi(stdout.join("\n"))).toContain(
      "Usage:   cf fuse-daemon <mountpoint> [options]",
    );
  });

  it("shows the supervisor's own help for the direct supervisor entry point", async () => {
    // The subcommand forwards its raw argv to the supervisor's parser, so the
    // compiled binary and a direct `deno run` of the supervisor produce the
    // same flags and the same help.
    const { code, stdout } = await cf("fuse-supervisor --help");

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain(
      "Usage: fuse-supervisor <mountpoint> [options]",
    );
    expect(stdout.join("\n")).toContain("--supervisor-status <path>");
  });

  it("rejects an unknown flag on the direct supervisor entry point", async () => {
    const { code, stdout, stderr } = await cf("fuse-supervisor /mnt --json");

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      "Unknown fuse supervisor option: --json",
    );
  });

  it("keeps rejection help off stdout when --json is unsupported", async () => {
    const { code, stdout, stderr } = await cf("acl --json");

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Unknown option "--json"',
    );
  });

  it("reports mounted exec errors without a stack", async () => {
    // A copy of its own, like the command trees above: every copy of
    // main.ts mounts the one `exec` its module exports, and a command
    // mounted under a root nothing has parsed has no types to parse with.
    const { exec } = await import("../commands/exec.ts?mounted-exec-errors");
    const errors = await withCapturedErrors(async () => {
      const code = await withMockExit(async () => {
        await exec.parse(["/tmp/not-mounted.handler"]);
      });

      expect(code).toBe(1);
    });

    expect(errors).toEqual([
      "Path is not within a mounted cf fuse filesystem: /tmp/not-mounted.handler",
    ]);
  });

  it("reports missing pattern test paths", async () => {
    const errors = await withCapturedErrors(async () => {
      const code = await withMockExit(async () => {
        await testCommand.parse(["./no-such-file.test.tsx"]);
      });

      expect(code).toBe(1);
    });

    expect(errors[0]).toContain("Error: Path not found:");
    expect(errors[0]).toContain("no-such-file.test.tsx");
  });

  it("reports empty pattern test globs", async () => {
    const errors = await withCapturedErrors(async () => {
      const code = await withMockExit(async () => {
        await testCommand.parse(["./no-such-*.test.tsx"]);
      });

      expect(code).toBe(1);
    });

    expect(errors).toEqual(["Error: No test files found"]);
  });

  it("skips glob matches that are not pattern tests", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(dir, "notes.txt"), "not a test");
      const errors = await withCapturedErrors(async () => {
        const code = await withMockExit(async () => {
          await testCommand.parse([`${dir}/*`]);
        });

        expect(code).toBe(1);
      });

      expect(errors).toEqual(["Error: No test files found"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reports a directory holding no pattern tests", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const errors = await withCapturedErrors(async () => {
        const code = await withMockExit(async () => {
          await testCommand.parse([dir]);
        });

        expect(code).toBe(1);
      });

      expect(errors).toEqual(["Error: No test files found"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reports a pattern test path that cannot be read", async () => {
    const file = await Deno.makeTempFile();
    try {
      // Descending into a regular file fails as NotADirectory, which is the
      // path's other error branch.
      const errors = await withCapturedErrors(async () => {
        const code = await withMockExit(async () => {
          await testCommand.parse([join(file, "child.test.tsx")]);
        });

        expect(code).toBe(1);
      });

      expect(errors[0]).toContain("Error accessing path");
    } finally {
      await Deno.remove(file);
    }
  });

  it("reports a pattern test path that is neither a file nor a directory", {
    ignore: Deno.build.os === "windows",
  }, async () => {
    const errors = await withCapturedErrors(async () => {
      const code = await withMockExit(async () => {
        await testCommand.parse(["/dev/null"]);
      });

      expect(code).toBe(1);
    });

    expect(errors[0]).toContain("is not a file or directory");
  });
});

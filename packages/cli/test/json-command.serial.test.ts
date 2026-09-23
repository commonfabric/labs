import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { ConsoleMethod } from "@commonfabric/runner";

import {
  handlePieceRenderNoUi,
  pieceCallRawArgs,
  writePieceRenderStatus,
} from "../commands/piece.ts";
import {
  hasJsonArgument,
  reservesStdoutForCommandOutput,
  stderrConsoleHandler,
} from "../lib/json-output.ts";
import { safeStringify } from "../lib/render.ts";
import { cf, stripAnsi } from "./utils.ts";

describe("JSON command contracts", () => {
  it("redirects runtime consoles without changing the console method", () => {
    const output = stderrConsoleHandler({
      metadata: undefined,
      method: ConsoleMethod.Assert,
      args: [true],
    });

    expect(Array.isArray(output)).toBe(false);
    if (Array.isArray(output)) throw new Error("Expected redirected output");
    expect(output.method).toBe(ConsoleMethod.Assert);
    expect(output.target).toBeDefined();
    for (const method of Object.values(ConsoleMethod)) {
      expect(typeof output.target?.[method]).toBe("function");
    }
  });

  it("recognizes explicit and implicit JSON output modes", () => {
    expect(
      reservesStdoutForCommandOutput([
        "check",
        "file.ts",
        "--pattern-json",
      ]),
    ).toBe(true);
    // Which data commands reserve stdout: reading does, writing does not,
    // because `set` reports in prose rather than on a machine surface.
    expect(reservesStdoutForCommandOutput(["cell", "get", "path"])).toBe(true);
    expect(reservesStdoutForCommandOutput(["piece", "call", "verb"])).toBe(
      true,
    );
    expect(reservesStdoutForCommandOutput(["cell", "set", "path"])).toBe(false);
    // The superseded spellings answer for as long as they are mounted, so
    // they reserve stdout on the same terms. A refusal reaching stdout is
    // what this guards, and it corrupts a caller's parse whichever spelling
    // they wrote.
    expect(reservesStdoutForCommandOutput(["get", "path"])).toBe(true);
    expect(reservesStdoutForCommandOutput(["call", "search"])).toBe(true);
    expect(reservesStdoutForCommandOutput(["set", "path"])).toBe(false);
    // `cf piece get` and `cf piece set` were removed outright rather than
    // moved, so nothing reserves stdout for them: a leftover entry would
    // suppress the help an unknown subcommand prints.
    expect(reservesStdoutForCommandOutput(["piece", "get", "path"])).toBe(
      false,
    );
    expect(reservesStdoutForCommandOutput(["piece", "set", "path"])).toBe(
      false,
    );
    // The label commands reserve it under either noun.
    expect(reservesStdoutForCommandOutput(["cell", "get-label", "path"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["cell", "set-label", "path"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["piece", "get-label", "path"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["piece", "set-label", "path"]))
      .toBe(true);
    // The bulk commands write their plan or their report to stdout, so they
    // reserve it whether or not --json is on the line.
    expect(reservesStdoutForCommandOutput(["piece", "survey", "--piece", "b"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["piece", "repair", "--piece", "b"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["piece", "retarget", "--plan", "p"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["piece", "rollback", "--plan", "p"]))
      .toBe(true);
    // The restore streams its revision listing to stdout in every mode, so
    // it reserves stdout as the plan-driven commands above do.
    expect(reservesStdoutForCommandOutput(["piece", "restore", "--piece", "b"]))
      .toBe(true);
    // A word that names a reserving subcommand does not reserve when it sits
    // in a flag's value or as another command's argument. Written against a
    // removed command these could only pass.
    expect(
      reservesStdoutForCommandOutput([
        "piece",
        "ls",
        "--space",
        "survey",
      ]),
    ).toBe(false);
    expect(reservesStdoutForCommandOutput(["piece", "new", "get-label"]))
      .toBe(false);
    // Bundled short options, which cliffy accepts and the walk has to take
    // apart by arity. The value belongs to the last value-taking letter, and
    // is the next token only when that letter ends the bundle.
    expect(
      reservesStdoutForCommandOutput(["piece", "-qs", "team", "call", "verb"]),
    ).toBe(true);
    expect(
      reservesStdoutForCommandOutput(["piece", "-qsi", "key", "call", "verb"]),
    ).toBe(true);
    expect(
      reservesStdoutForCommandOutput(["cell", "-qs", "team", "get", "path"]),
    ).toBe(true);
    // The same bundle over a word that would reserve if it were read as the
    // subcommand rather than as `-s`'s value.
    expect(reservesStdoutForCommandOutput(["piece", "-qs", "survey"]))
      .toBe(false);
    // `-q` alone takes no value, so the word after it is the subcommand.
    expect(reservesStdoutForCommandOutput(["piece", "-q", "survey"]))
      .toBe(true);
    // A bundle carrying its own value consumes no following token, so the
    // subcommand is still the word after it.
    expect(reservesStdoutForCommandOutput(["piece", "-s=team", "call", "verb"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["exec", "/tmp/search.tool"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["wish", "#profile"])).toBe(true);
    expect(reservesStdoutForCommandOutput(["piece", "inspect"])).toBe(false);
    expect(hasJsonArgument(["--json-file", "input.json"])).toBe(true);
    expect(safeStringify(undefined)).toBe("null");
    expect(JSON.parse(safeStringify({ count: 42n }))).toEqual({
      count: { $bigint: "42" },
    });
  });

  it("keeps the profiling marker off pattern JSON stdout", async () => {
    const env = { CF_PROFILE_DONE_MARKER: "profile finished" };
    const { code, stdout, stderr } = await cf(
      "check fixtures/check-json-no-evaluate.ts --pattern-json",
      { env },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual(["1"]);
    expect(stderr.join("\n")).toContain("profile finished");

    const transformed = await cf(
      "check fixtures/check-json-no-evaluate.ts --show-transformed",
      { env },
    );
    expect(transformed.code).toBe(0);
    expect(transformed.stdout.join("\n")).not.toContain("profile finished");
    expect(transformed.stderr.join("\n")).toContain("profile finished");
  });

  it("keeps parser help off reserved stdout modes", async () => {
    for (
      const command of [
        "check --pattern-json --bogus fixtures/pow-5.tsx",
        "get --bogus",
        "piece get-label --bogus",
        "piece set-label --bogus",
        "piece --bogus survey",
        "wish --bogus #profile",
        // Bundled beside unbundled, because cliffy accepts both and only the
        // walk here tells them apart. A bundle whose value was not skipped
        // reads `team` as the subcommand, reserves nothing, and prints the
        // usage page onto the stream the caller is parsing.
        "piece -q -s team call --bogus",
        "piece -qs team call --bogus",
        "piece -qsi key call --bogus",
        "cell -qs team get --bogus",
      ]
    ) {
      const { code, stdout, stderr } = await cf(command);

      expect(code).toBe(2);
      expect(stdout).toEqual([]);
      expect(stripAnsi(stderr.join("\n"))).toContain("Unknown option");
    }
  });

  it("does not reserve stdout for unrelated piece argument values", async () => {
    for (
      const command of [
        "piece new get-label --bogus",
        "piece ls --space survey --bogus",
        // The same value under a bundle. `survey` reserves stdout as a
        // subcommand, so a walk that read this one as the subcommand rather
        // than as `-s`'s value would suppress the help this asserts.
        "piece -qs survey --bogus",
      ]
    ) {
      const { code, stdout, stderr } = await cf(command);

      expect(code).toBe(2);
      expect(stripAnsi(stdout.join("\n"))).toContain("Usage:");
      expect(stripAnsi(stderr.join("\n"))).toContain("Unknown option");
    }
  });

  it("rejects inspect html --json before opening the space", async () => {
    const { code, stdout, stderr } = await cf(
      "inspect html no-such-space --json",
    );

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Option "--json" and the "html" command are mutually exclusive.',
    );
  });

  it("rejects inspect --json without a data subcommand", async () => {
    const { code, stdout, stderr } = await cf("inspect --json");

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Option "--json" requires an inspect data subcommand.',
    );
  });

  it("rejects inspect graph --dot --json", async () => {
    const { code, stdout, stderr } = await cf(
      "inspect graph no-such-space --dot --json",
    );

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Option "--dot" conflicts with option "--json".',
    );
  });

  it("rejects static human help when --json is present", async () => {
    const { code, stdout, stderr } = await cf("wish --json --help");

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Option "--help" cannot be combined with other options.',
    );
  });

  it("documents redundant --json options on JSON-only reads", async () => {
    const pieceGet = await cf("cell get --help");
    const wish = await cf("wish --help");

    expect(pieceGet.code).toBe(0);
    expect(stripAnsi(pieceGet.stdout.join("\n"))).toContain("--json");
    expect(wish.code).toBe(0);
    expect(stripAnsi(wish.stdout.join("\n"))).toContain("--json");
  });

  it("rejects --json forwarded to fuse-daemon", async () => {
    for (
      const invocation of [
        "fuse-daemon /tmp/commonfabric-json-test --json",
        "fuse-daemon --json /tmp/commonfabric-json-test",
      ]
    ) {
      const { code, stdout, stderr } = await cf(invocation);

      expect(code).not.toBe(0);
      expect(stdout).toEqual([]);
      expect(stripAnsi(stderr.join("\n"))).toContain(
        'Unknown option "--json".',
      );
    }
  });
});

describe("call JSON arguments", () => {
  it("passes explicit JSON input through like cf exec", () => {
    expect(pieceCallRawArgs(["--json"])).toEqual(["--json"]);
    expect(pieceCallRawArgs(["--json", '{"query":"milk"}'])).toEqual([
      "--json",
      '{"query":"milk"}',
    ]);
  });

  it("retains positional JSON and the schema-derived flags beside it", () => {
    expect(pieceCallRawArgs(['{"query":"milk"}'])).toEqual([
      "--json",
      '{"query":"milk"}',
    ]);
    // The verb opened the section, so its flags stand there with no marker
    // between them and the name.
    expect(pieceCallRawArgs(["--query", "milk"])).toEqual([
      "--query",
      "milk",
    ]);
  });

  it("reports a verb's own flag past the marker as a validation error", async () => {
    // The spelling this grammar replaces, and the one every caller migrating
    // writes first. The refusal prints the line that works rather than
    // reporting an unknown name.
    const { code, stdout, stderr } = await cf(
      "piece call --identity ./missing.key --api-url http://127.0.0.1:1 --space test --piece example search -- --query milk",
    );

    expect(code).toBe(2);
    expect(stdout).toEqual([]);
    const errors = stripAnsi(stderr.join("\n"));
    expect(errors).toContain('"--query" is not a read option');
    expect(errors).toContain(
      "write:    cf piece call --identity ./missing.key --api-url " +
        "http://127.0.0.1:1 --space test --piece example search --query milk",
    );
    expect(errors).not.toContain("pieceCallRawArgs");
  });

  it("writes watch status to stderr in JSON mode", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));

    try {
      writePieceRenderStatus("Watching for changes", true);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(logs).toEqual([]);
    expect(errors).toEqual(["Watching for changes"]);
  });

  it("treats a missing UI as an error in JSON mode", () => {
    expect(() =>
      handlePieceRenderNoUi(
        new Error("Piece example has no UI"),
        true,
      )
    ).toThrow("Piece example has no UI");
  });
});

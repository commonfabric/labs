import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Command } from "@cliffy/command";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { declaredSlots } from "../runtime/cli/lib/completion/line.ts";
import {
  describeFailures,
  main,
  NO_CANDIDATES,
  NO_OPTION_CANDIDATES,
  reportSlots,
  type SlotReport,
} from "./check-completion-slots.ts";

/** A small tree in the shape the CLI's own is: nested commands, each with its
 * own options and positionals. */
function fixtureTree() {
  return new Command()
    .name("cf")
    .option("--space <space:string>", "a space")
    .option("--quiet", "no value, so not a slot")
    .command("piece", new Command().description("piece things"))
    .command(
      "get",
      new Command()
        .description("read")
        .option("--select <fields:string>", "a projection")
        .arguments("<path:string>"),
    );
}

/**
 * One option name meaning two things on two commands, as `--from` does: a
 * snapshot file on `space clone` and a sequence number on `inspect diff`.
 */
function twoMeaningsTree() {
  return new Command()
    .name("cf")
    .command(
      "clone",
      new Command().description("copy a space")
        .option("--from <file:string>", "a snapshot file"),
    )
    .command(
      "diff",
      new Command().description("compare two revisions")
        .option("--from <n:number>", "a sequence number"),
    );
}

/** The report for a tree, told about `known`. */
function reportFor(known: {
  /** Option name -> the commands its provider answers on, `null` for all. */
  providerOptions?: Record<string, readonly string[] | null>;

  providerArguments?: string[];
  enumerated?: string[];
  allowedOptions?: string[];
  allowedPositionals?: string[];
  // deno-lint-ignore no-explicit-any
}, tree: Command<any> = fixtureTree()): SlotReport {
  return reportSlots(declaredSlots(tree), {
    providerOptions: new Map(Object.entries(known.providerOptions ?? {})),
    providerArguments: new Set(known.providerArguments ?? []),
    enumerated: new Set(known.enumerated ?? []),
    allowedOptions: new Set(known.allowedOptions ?? []),
    allowedPositionals: new Set(known.allowedPositionals ?? []),
  });
}

/**
 * A tree whose slots the real provider tables have never heard of, which is
 * what a command looks like the day it lands.
 */
function unknownTree() {
  return new Command()
    .name("cf")
    .command(
      "fixture",
      new Command()
        .description("a command no provider table names")
        .option("--fixture-flag <value:string>", "a value nothing provides")
        .arguments("<fixtureArg:string>"),
    );
}

/** Run `body` with console output captured, as the other task tests do. */
function captureConsole(
  body: () => number,
): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    return { code: body(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Run the gate the way its task does, and return what the process reported. */
async function runAsProgram(
  ...args: string[]
): Promise<{ code: number; out: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(REPO_ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      // The permissions deno.jsonc grants the task, so a run that needs more
      // than the task allows fails here rather than in CI.
      "--allow-read",
      "--allow-env",
      "--allow-sys",
      "--allow-ffi",
      join(REPO_ROOT, "tasks/check-completion-slots.ts"),
      ...args,
    ],
  });
  return { code: output.code, out: new TextDecoder().decode(output.stdout) };
}

/** `providerOptions` for names whose provider answers on every command. */
function everywhere(...names: string[]): Record<string, null> {
  return Object.fromEntries(names.map((name) => [name, null]));
}

describe("check-completion-slots", () => {
  describe("reportSlots()", () => {
    it("names an option with no provider, no enumerated set and no allowance", () => {
      const report = reportFor({});
      expect(report.undecidedOptions).toEqual([
        "--select  (get)",
        "--space  (<root>)",
      ]);
    });

    it("returns no finding for an option a provider answers", () => {
      expect(
        reportFor({ providerOptions: everywhere("space", "select") })
          .undecidedOptions,
      )
        .toEqual([]);
    });

    it("returns no finding for an option an enumerated set answers", () => {
      expect(
        reportFor({
          providerOptions: everywhere("space"),
          enumerated: ["select"],
        })
          .undecidedOptions,
      ).toEqual([]);
    });

    it("returns no finding for an option the allowlist records a reason for", () => {
      expect(
        reportFor({
          providerOptions: everywhere("space"),
          allowedOptions: ["select"],
        })
          .undecidedOptions,
      ).toEqual([]);
    });

    it("names the commands a scoped provider does not answer on", () => {
      // A provider restricted to one command answers nothing on the other, so
      // the slot there is as silent as one with no entry at all.

      expect(
        reportFor({ providerOptions: { from: ["clone"] } }, twoMeaningsTree())
          .undecidedOptions,
      ).toEqual(["--from  (diff)"]);
    });

    it("takes no bare allowance for an option a provider answers somewhere", () => {
      // `--from` has candidates on `clone`, so a bare allowance saying it has
      // none is false wherever it is read; the other command needs its own.

      const bare = reportFor(
        { providerOptions: { from: ["clone"] }, allowedOptions: ["from"] },
        twoMeaningsTree(),
      );
      expect(bare.undecidedOptions).toEqual(["--from  (diff)"]);
      expect(bare.staleAllowlist).toEqual(["--from"]);

      const scoped = reportFor(
        { providerOptions: { from: ["clone"] }, allowedOptions: ["diff:from"] },
        twoMeaningsTree(),
      );
      expect(scoped.undecidedOptions).toEqual([]);
      expect(scoped.staleAllowlist).toEqual([]);
    });

    it("names a positional with no provider and no allowance", () => {
      expect(reportFor({}).undecidedPositionals).toEqual(["get:path"]);
      expect(
        reportFor({ providerArguments: ["get:path"] }).undecidedPositionals,
      )
        .toEqual([]);
      expect(
        reportFor({ allowedPositionals: ["get:path"] }).undecidedPositionals,
      )
        .toEqual([]);
    });

    it("names a provider entry that matches no slot on the tree", () => {
      // The same subtraction the other way: this is what found `log-file` and
      // `state-path`, which belonged to commands declaring no Cliffy options.

      expect(
        reportFor({
          providerOptions: everywhere("log-file"),
          providerArguments: ["x:y"],
        })
          .unreachableProviders,
      ).toEqual(["--log-file", "x:y"]);
    });

    it("names a command a scoped provider claims and the tree does not", () => {
      // A scope naming a command that never declared the option is the same
      // dead entry, one level down.

      expect(
        reportFor(
          { providerOptions: { from: ["clone", "pull"] } },
          twoMeaningsTree(),
        ).unreachableProviders,
      ).toEqual(["--from  (pull)"]);
    });

    it("names an allowlist entry that decides no slot", () => {
      // A decision cannot outlive the thing it was about.

      expect(
        reportFor({ allowedOptions: ["gone"], allowedPositionals: ["gone:x"] })
          .staleAllowlist,
      ).toEqual(["--gone", "gone:x"]);
    });

    it("names an allowance for a slot a provider already answers", () => {
      // Two records of one decision, disagreeing: the provider offers
      // candidates the allowance says are not there.

      expect(
        reportFor({
          providerOptions: everywhere("select"),
          allowedOptions: ["get:select"],
        }).staleAllowlist,
      ).toEqual(["--select  (get)"]);
    });
  });

  describe("describeFailures()", () => {
    it("returns nothing when the report is empty", () => {
      expect(describeFailures(reportFor({
        providerOptions: everywhere("space", "select"),
        providerArguments: ["get:path"],
      }))).toEqual([]);
    });

    it("names the table to edit for each kind of finding", () => {
      const text = describeFailures(reportFor({})).join("\n");
      expect(text).toContain("NO_OPTION_CANDIDATES");
      expect(text).toContain("NO_CANDIDATES");
    });

    it("names the entry to delete when one reaches nothing", () => {
      // The subtraction run the other way has its own paragraph, and it has to
      // name the dead entry: the fix is to delete that line, not to add a slot.

      const text = describeFailures(reportFor({
        providerOptions: everywhere("space", "select", "log-file"),
        providerArguments: ["get:path"],
        allowedOptions: ["gone"],
      })).join("\n");
      expect(text).toContain("provider entr(ies) match no slot");
      expect(text).toContain("--log-file");
      expect(text).toContain("allowlist entr(ies) decide no slot");
      expect(text).toContain("--gone");
    });
  });

  describe("main()", () => {
    it("returns 0 for the CLI's own command tree", () => {
      // The gate itself. Every slot the CLI declares is answered by a provider,
      // by an enumerated set, or by an allowlist entry carrying its reason.

      expect(main()).toBe(0);
    });

    it("fails a slot no table names, printing the finding and the remedy", () => {
      const { code, err } = captureConsole(() => main([], unknownTree()));
      expect(code).toBe(1);
      expect(err).toContain("--fixture-flag  (fixture)");
      expect(err).toContain("fixture:fixtureArg");
      expect(err).toContain("Either give the slot candidates");
      // Nothing the tables name is on this tree, so the subtraction the other
      // way reports every entry at once.
      expect(err).toContain("provider entr(ies) match no slot");
    });

    it("lists the undecided slots and succeeds when asked for the list", () => {
      // `--list` is the working view: it answers what is undecided without
      // failing, so the list can be read while it is worked through.

      const { code, out } = captureConsole(() =>
        main(["--list"], unknownTree())
      );
      expect(code).toBe(0);
      expect(out).toContain("Undecided options:");
      expect(out).toContain("--fixture-flag  (fixture)");
      expect(out).toContain("Undecided positionals:");
      expect(out).toContain("fixture:fixtureArg");
    });

    it("records a reason for every allowance, so none is a bare exemption", () => {
      // Trimmed, because a blank reason and a spaces-only one exempt a slot
      // just as silently.

      for (const [key, reason] of [...NO_CANDIDATES, ...NO_OPTION_CANDIDATES]) {
        expect(reason.trim().length, `${key} has no reason`).toBeGreaterThan(0);
      }
    });
  });

  describe("as the task runs it", () => {
    // Calling main() above would still pass if the entry point never ran it,
    // or if the permissions the task declares were too narrow to walk the
    // tree. This is the promise the CI job makes: the command exits 0, having
    // done the work.

    it("exits 0 reporting the slots it walked", async () => {
      const { code, out } = await runAsProgram();
      expect(code).toBe(0);
      expect(out).toContain("Completion slots OK");
      expect(out).toMatch(/\d+ option slot\(s\) over \d+ name\(s\)/);
    });

    it("exits 0 listing what is undecided when asked for the list", async () => {
      const { code, out } = await runAsProgram("--list");
      expect(code).toBe(0);
      expect(out).toContain("Undecided options:");
      expect(out).toContain("Undecided positionals:");
    });
  });
});

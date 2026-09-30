/**
 * The Claude Code hooks under `.claude/scripts/`. Each hook is a separate
 * program, so each test here starts one the way `.claude/settings.json` starts
 * it and writes a tool call to its standard input.
 *
 * A hook decides whether a tool call proceeds by matching a pattern in it.
 * These tests record that decision for a set of commands: which are refused
 * and which are allowed. Most of the commands are ones that must be allowed.
 * Refusing a correct command stops work and prints a message that does not
 * apply to it, whereas allowing an incorrect one only omits a reminder.
 *
 * These tests are in `tasks/` because `.claude/` is not a workspace member and
 * has no test task that would run them.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

interface HookResult {
  readonly code: number;
  readonly stdout: string;
}

/**
 * Runs the named hook with `payload` on standard input, under the permissions
 * `.claude/settings.json` grants it. `CLAUDE_PROJECT_DIR` names the checkout
 * the test runs in, so the hook's project-directory guard sees this repository
 * rather than the directory the surrounding shell was in.
 *
 * A hook reads its payload from standard input, and
 * `@commonfabric/test-support/isolated-deno` does not write to a child's
 * standard input, so the child process is started here instead. `--no-lock`
 * supplies the property that helper exists for: the child cannot write
 * `deno.lock`. A hook imports nothing outside its own directory, so the flag
 * leaves no dependency graph unverified.
 */
async function runHook(
  name: string,
  payload: Record<string, unknown>,
): Promise<HookResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-lock",
      "--allow-read",
      "--allow-env",
      `${REPO_ROOT}/.claude/scripts/${name}.ts`,
    ],
    cwd: REPO_ROOT,
    env: { CLAUDE_PROJECT_DIR: REPO_ROOT },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
  };
}

/** Runs a hook that inspects `tool_input.command`. */
function onCommand(name: string, command: string): Promise<HookResult> {
  return runHook(name, { tool_input: { command } });
}

/** Runs a hook that inspects `tool_input.file_path`. */
function onFilePath(name: string, filePath: string): Promise<HookResult> {
  return runHook(name, { tool_input: { file_path: filePath } });
}

/** The exit code a hook uses to refuse the tool call. */
const REFUSED = 2;
const ALLOWED = 0;

describe("claude-hooks", () => {
  describe("block-node.ts", () => {
    const refuses = async (command: string) =>
      expect((await onCommand("block-node", command)).code).toBe(REFUSED);
    const allows = async (command: string) =>
      expect((await onCommand("block-node", command)).code).toBe(ALLOWED);

    it("refuses a command that runs `npm`", async () => {
      await refuses("npm install");
    });

    it("refuses a run on the second line of a command", async () => {
      await refuses("cd packages/ui\nnpm install");
    });

    it("refuses an indented run", async () => {
      await refuses("   npm install lodash");
    });

    it("refuses a run inside a command substitution", async () => {
      await refuses("echo $(npm bin)");
    });

    it("refuses a run in a command that also commits", async () => {
      await refuses("git commit -m 'wip' && npm install");
    });

    it("allows a path under `node_modules`", async () => {
      await allows("ls node_modules");
    });

    it("allows the name inside a quoted argument", async () => {
      await allows('echo "first do this; npm is banned"');
    });

    it("allows the name inside a multi-line commit message", async () => {
      await allows('git commit -m "drop npm\n\nnode is unused here."');
    });

    it("allows the name inside a heredoc body", async () => {
      await allows("cat > f <<EOF\nnpm install\nEOF");
    });

    it("allows a heredoc body line starting with the delimiter", async () => {
      await allows("cat > f <<EOF\nEOFX\nnpm install\nEOF");
    });

    it("allows a heredoc whose delimiter carries punctuation", async () => {
      await allows("cat > f <<'EOF-1'\nnpm install\nEOF-1");
    });

    it("refuses a run inside a backtick substitution", async () => {
      await refuses("echo `npm bin`");
    });

    it("refuses a substitution inside a double-quoted string", async () => {
      await refuses('X="$(npm bin)"');
    });
  });

  describe("block-legacy-cli.ts", () => {
    const refuses = async (command: string) =>
      expect((await onCommand("block-legacy-cli", command)).code).toBe(REFUSED);
    const allows = async (command: string) =>
      expect((await onCommand("block-legacy-cli", command)).code).toBe(ALLOWED);

    it("refuses `ct` at the start of a command", async () => {
      await refuses("ct dev");
    });

    it("refuses `ct` run from the working directory", async () => {
      await refuses("./ct dev");
    });

    it("refuses `ct` in a command that also commits", async () => {
      await refuses("git commit -m wip && ct piece ls");
    });

    it("allows `ct` as an argument to another program", async () => {
      await allows("grep ct packages/runner/src/index.ts");
    });

    it("allows a filename ending in `ct`", async () => {
      await allows("cat a.ct");
    });

    it("allows `ct` inside a heredoc body", async () => {
      await allows("cat > f <<'EOF'\nct piece ls\nEOF");
    });

    it("refuses `ct` inside a backtick substitution", async () => {
      await refuses("echo `ct dev`");
    });
  });

  describe("deno-test-filter.ts", () => {
    const refuses = async (command: string) =>
      expect((await onCommand("deno-test-filter", command)).code).toBe(REFUSED);
    const allows = async (command: string) =>
      expect((await onCommand("deno-test-filter", command)).code).toBe(ALLOWED);

    it("refuses `--filter` on the root task", async () => {
      await refuses('deno task test --filter "a name"');
    });

    it("allows the flag after a change of directory", async () => {
      await allows('cd packages/html\ndeno task test --filter "a name"');
    });

    it("allows the flag after a change of directory on one line", async () => {
      await allows('cd packages/html && deno task test --filter "a name"');
    });

    it("refuses a filter that precedes a change of directory", async () => {
      await refuses("deno task test --filter a && cd packages/html");
    });

    it("allows the root task with no filter", async () => {
      await allows("deno task test");
    });

    it("allows a filtered `deno test`", async () => {
      await allows("deno test --filter a");
    });

    it("allows a `--filter` belonging to a later command", async () => {
      await allows("deno task test && ls --filter");
    });
  });

  describe("pre-edit-reminders.ts", () => {
    const contextFor = async (filePath: string) => {
      const result = await onFilePath("pre-edit-reminders", filePath);
      expect(result.code).toBe(ALLOWED);
      if (result.stdout === "") return "";
      const output = JSON.parse(result.stdout).hookSpecificOutput;
      // A reminder carries text and no permission decision, so adding a note
      // to an edit does not also approve that edit.
      expect(output.permissionDecision).toBeUndefined();
      return output.additionalContext as string;
    };

    it("names the pattern documentation for a pattern", async () => {
      expect(await contextFor("packages/patterns/lunch-poll/main.tsx"))
        .toContain("pattern-dev");
    });

    it("says nothing for a `.tsx` file outside the pattern trees", async () => {
      expect(
        await contextFor("packages/ts-transformers/test/fixtures/a.tsx"),
      ).toBe("");
    });

    it("names the pattern documentation for a connector pattern", async () => {
      expect(
        await contextFor("packages/connectors/github/activity-view/main.tsx"),
      ).toContain("pattern-dev");
    });

    it("says nothing for a connector test fixture", async () => {
      expect(
        await contextFor(
          "packages/connectors/agents/host/test/fixtures/raw-session-view.tsx",
        ),
      ).toBe("");
    });

    it("names the component documentation under `packages/ui`", async () => {
      expect(await contextFor("packages/ui/src/v2/cf-button.ts"))
        .toContain("lit-component");
    });

    it("says nothing for source outside either area", async () => {
      expect(await contextFor("packages/runner/src/builder.ts")).toBe("");
    });
  });
});

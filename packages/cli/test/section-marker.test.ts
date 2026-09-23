import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import { refuseSectionMarker } from "../lib/section-marker.ts";
import { pieceDataCommand } from "../commands/piece.ts";
import { wish } from "../commands/wish.ts";

/**
 * `--` closes a callable's section. A command without one sets every word
 * after the marker aside, and an action reading none of them returns a value
 * the caller did not ask for and exits zero.
 *
 * These hold the refusal to firing at all — the parse tests below are what
 * prove the words really do reach the literal arguments on a real command,
 * which is the half a unit test of the helper alone cannot see.
 */
describe("section-marker", () => {
  describe("refuseSectionMarker()", () => {
    it("returns for arguments carrying no marker", () => {
      expect(() => refuseSectionMarker("cell get", [])).not.toThrow();
      expect(() => refuseSectionMarker("cell get", ["addr", "items/0"]))
        .not.toThrow();
    });

    it("refuses a marker with nothing after it", () => {
      // The case the literal arguments cannot see: a trailing marker sets no
      // words aside, so `getLiteralArgs()` is empty and identical to a line
      // that wrote none. Reading the marker itself is what tells them apart.
      expect(() => refuseSectionMarker("cell get", ["addr", "--"]))
        .toThrow(/closes nothing/);
    });

    it("names the words the marker would have set aside", () => {
      expect(() => refuseSectionMarker("cell get", ["--", "--select", "title"]))
        .toThrow(/--select title/);
    });

    it("writes the corrected line without the marker", () => {
      let message = "";
      try {
        refuseSectionMarker("cell get", ["addr", "--", "--select", "title"]);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("written:  cf cell get addr -- --select title");
      expect(message).toContain("write:    cf cell get addr --select title");
    });

    it("names the command the marker was written on", () => {
      expect(() => refuseSectionMarker("cell get", ["--", "--select", "t"]))
        .toThrow(/cf cell get/);
    });

    it("names the two commands the marker is written on", () => {
      // A refusal that only says no leaves the caller to find where the
      // spelling does work.
      let message = "";
      try {
        refuseSectionMarker("wish", ["--", "--select", "name"]);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("cf piece call");
      expect(message).toContain("cf exec");
    });

    it("throws a ValidationError, so the CLI reports it as a usage error", () => {
      expect(() => refuseSectionMarker("cell get", ["--", "x"]))
        .toThrow(ValidationError);
    });
  });

  describe("on the commands that have no callable section", () => {
    /**
     * Parse `args` and return what cliffy printed.
     *
     * A `ValidationError` reaches the caller as help output plus an exit, so
     * the refusal is read where a caller reads it — off stderr — rather than
     * as a thrown value. Same idiom as `wish-command.serial.test.ts`.
     */
    async function outputFrom(
      // deno-lint-ignore no-explicit-any
      command: { parse: (args: string[]) => Promise<any> },
      args: string[],
    ): Promise<{ text: string; exitCode: number | null }> {
      const originalExit = Deno.exit;
      const originalLog = console.log;
      const originalError = console.error;
      const written: string[] = [];
      let exitCode: number | null = null;
      Deno.exit = ((code?: number): never => {
        exitCode = code ?? 0;
        throw new Error("exit sentinel");
      }) as typeof Deno.exit;
      console.log = (...parts: unknown[]) => written.push(parts.join(" "));
      console.error = (...parts: unknown[]) => written.push(parts.join(" "));
      try {
        await command.parse(args);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "exit sentinel") {
          written.push(String(error));
        }
      } finally {
        Deno.exit = originalExit;
        console.log = originalLog;
        console.error = originalError;
      }
      return { text: written.join("\n"), exitCode };
    }

    it("refuses a marker on `get` rather than discarding the words", async () => {
      // Without the guard this parse reaches the action with an empty
      // `--select` and returns an unprojected value — the silent wrong answer
      // the refusal is for.
      const { text, exitCode } = await outputFrom(
        pieceDataCommand("get", { spelling: "cell get" }),
        ["addr", "--", "--select", "title"],
      );
      expect(text).toContain("closes a callable's section");
      expect(text).toContain("--select title");
      // The refusal writes the corrected line back in the spelling its mount
      // carries, so the line a caller is handed is one they can paste: the
      // canonical spelling, not the superseded top-level one the same builder
      // also answers at.
      expect(text).toContain("cf cell get addr --select title");
      // 2 is cliffy's exit for a validation error, which is what this is —
      // the point being that it is not 0, which is what the silent discard
      // returned.
      expect(exitCode).toBe(2);
    });

    it("refuses a marker on `set`", async () => {
      const { text } = await outputFrom(
        pieceDataCommand("set", { spelling: "cell set" }),
        ["addr", "--", "--json", "1"],
      );
      expect(text).toContain("closes a callable's section");
      expect(text).toContain("cf cell set addr --json 1");
    });

    it("refuses a marker on `wish`", async () => {
      const { text } = await outputFrom(wish, [
        "#profile",
        "--",
        "--select",
        "name",
      ]);
      expect(text).toContain("closes a callable's section");
    });

    it("refuses a trailing marker on every command that has no section", async () => {
      // `cf cell get addr --` sets no words aside, so the literal arguments
      // are empty and look exactly like `cf cell get addr`. Each of these
      // three would have been accepted by a guard reading what followed the
      // marker.
      for (
        const [name, command, args] of [
          [
            "get",
            pieceDataCommand("get", { spelling: "cell get" }),
            ["addr", "--"],
          ],
          [
            "set",
            pieceDataCommand("set", { spelling: "cell set" }),
            ["addr", "--"],
          ],
          ["wish", wish, ["#profile", "--"]],
        ] as const
      ) {
        const { text } = await outputFrom(command, [...args]);
        expect(text, name).toContain("closes a callable's section");
        expect(text, name).toContain("closes nothing");
      }
    });

    it("leaves a line that writes no marker to its own validation", async () => {
      // The guard must not become the error every incomplete line reports:
      // this one is refused too, but for the identity and api-url it never
      // named.
      const { text } = await outputFrom(
        pieceDataCommand("get", { spelling: "cell get" }),
        ["addr"],
      );
      expect(text).not.toContain("closes a callable's section");
    });

    it("leaves `call` to read what the marker set aside", async () => {
      // `call` declares stopEarly() and its action reads the literal
      // arguments, so the marker is the boundary it exists for. A refusal
      // here would take away the spelling the design prescribes.
      const { text } = await outputFrom(
        pieceDataCommand("call", { spelling: "piece call" }),
        ["addr", "verb", "--", "--select", "title"],
      );
      expect(text).not.toContain("closes a callable's section");
    });
  });
});

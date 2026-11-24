import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { type CommandOutput, emit } from "./command-output.ts";

describe("command-output", () => {
  describe("emit()", () => {
    /** Run `emit(shown)` with the console and `Deno.exit` captured. */
    const emitted = (shown: CommandOutput) => {
      const out: unknown[][] = [];
      const err: unknown[][] = [];
      let code: number | undefined;
      // `Deno.exit` never returns, so the stand-in throws to end `emit()` too.
      const exited = new Error("`Deno.exit()` called");
      const log = stub(console, "log", (...args) => {
        out.push(args);
      });
      const error = stub(console, "error", (...args) => {
        err.push(args);
      });
      const exit = stub(Deno, "exit", (exitCode) => {
        code = exitCode;
        throw exited;
      });
      try {
        emit(shown);
      } catch (thrown) {
        if (thrown !== exited) throw thrown;
      } finally {
        exit.restore();
        error.restore();
        log.restore();
      }
      return { out, err, code };
    };

    it("prints `out` to standard output and `err` to standard error, then exits with the code", () => {
      expect(emitted({ out: "fine", err: "broken", code: 3 })).toEqual({
        out: [["fine"]],
        err: [["broken"]],
        code: 3,
      });
    });

    it("prints nothing for what the command left unsaid", () => {
      expect(emitted({ code: 0 })).toEqual({ out: [], err: [], code: 0 });
    });
  });
});

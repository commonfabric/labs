import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { renderExecOutcome } from "../commands/exec.ts";

describe("renderExecOutcome()", () => {
  it("writes a help page alone, whatever else the result carries", () => {
    const out: string[] = [];
    const err: string[] = [];

    renderExecOutcome(
      {
        helpText: "Usage: cf exec add.handler",
        outputText: "{}",
        invocation: { id: "inv-1", status: "settled", result: 1 },
      },
      {
        write: (text) => out.push(text),
        writeError: (text) => err.push(text),
      },
    );

    expect(out).toEqual(["Usage: cf exec add.handler"]);
    expect(err).toEqual([]);
  });

  it("writes nothing for a result with no help, output, or invocation", () => {
    const out: string[] = [];

    renderExecOutcome({}, { write: (text) => out.push(text) });

    expect(out).toEqual([]);
  });
});

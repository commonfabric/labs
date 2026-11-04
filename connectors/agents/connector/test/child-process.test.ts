import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { terminateChildProcess } from "../src/child-process.ts";

describe("terminateChildProcess()", () => {
  it("sends `SIGTERM` to a process that is still running", () => {
    const signals: (Deno.Signal | number | undefined)[] = [];
    terminateChildProcess({
      kill: (signal) => {
        signals.push(signal);
      },
    });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("returns when `kill()` throws because the process was already reaped", () => {
    let asked = false;
    expect(() =>
      terminateChildProcess({
        kill: () => {
          asked = true;
          throw new TypeError("Child process has already terminated");
        },
      })
    ).not.toThrow();
    expect(asked).toBe(true);
  });
});

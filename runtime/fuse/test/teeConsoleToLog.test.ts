import { expect } from "@std/expect";

import { teeConsoleToLog } from "../mod.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const decoder = new TextDecoder();

describe("teeConsoleToLog()", () => {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  let echoed: string[];
  const echoTo = (name: string) => (...args: unknown[]) => {
    echoed.push(`${name}: ${args.join(" ")}`);
  };
  const echoes = {
    log: echoTo("log"),
    warn: echoTo("warn"),
    error: echoTo("error"),
  };

  beforeEach(() => {
    echoed = [];
    Object.assign(console, echoes);
  });

  afterEach(() => {
    Object.assign(console, original);
  });

  /** A log that keeps each line written to it. */
  function memoryLog() {
    const lines: string[] = [];
    return {
      lines,
      writeSync(data: Uint8Array): number {
        lines.push(decoder.decode(data));
        return data.length;
      },
    };
  }

  function logThroughEachMethod(): void {
    console.log("mounted at", "/mnt", 1);
    console.warn("slow");
    console.error("lost", { n: 2 });
  }

  it("writes each console line to the log, and nowhere else without echo", () => {
    const log = memoryLog();

    {
      using _tee = teeConsoleToLog(log, false);
      logThroughEachMethod();
    }

    expect(log.lines).toEqual([
      "mounted at /mnt 1\n",
      "slow\n",
      "lost [object Object]\n",
    ]);
    expect(echoed).toEqual([]);
  });

  it("also passes each line on to the console with echo", () => {
    const log = memoryLog();

    {
      using _tee = teeConsoleToLog(log, true);
      logThroughEachMethod();
    }

    expect(log.lines).toHaveLength(3);
    expect(echoed).toEqual([
      "log: mounted at /mnt 1",
      "warn: slow",
      "error: lost [object Object]",
    ]);
  });

  it("drops a line the log cannot take and still echoes it", () => {
    const failing = {
      writeSync(): number {
        throw new Deno.errors.WriteZero("disk full");
      },
    };

    {
      using _tee = teeConsoleToLog(failing, true);
      console.error("still visible");
    }

    expect(echoed).toEqual(["error: still visible"]);
  });

  it("gives the console back its own methods once disposed", () => {
    const log = memoryLog();

    teeConsoleToLog(log, true)[Symbol.dispose]();
    logThroughEachMethod();

    expect([console.log, console.warn, console.error]).toEqual([
      echoes.log,
      echoes.warn,
      echoes.error,
    ]);
    expect(log.lines).toEqual([]);
    expect(echoed).toHaveLength(3);
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import {
  getGlobalLogFloor,
  getLogger,
  setGlobalLogFloor,
} from "../src/logger.ts";
import { captureLogsForTestingOnly } from "../src/for-testing-only.ts";

describe("captureLogsForTestingOnly()", () => {
  const logger = getLogger("capture-test");
  const other = getLogger("capture-test-other");
  let printed: Stub<Console>;
  let priorToStderr: string | undefined;

  beforeEach(() => {
    priorToStderr = Deno.env.get("LOG_TO_STDERR");
    Deno.env.delete("LOG_TO_STDERR");
    logger.disabled = true;
    logger.level = "error";
    other.disabled = false;
    other.level = "debug";
    setGlobalLogFloor("error");
    printed = stub(console, "debug");
  });

  afterEach(() => {
    printed.restore();
    setGlobalLogFloor(undefined);
    if (priorToStderr === undefined) Deno.env.delete("LOG_TO_STDERR");
    else Deno.env.set("LOG_TO_STDERR", priorToStderr);
  });

  it("records the logger's lines at every level, with their keys and resolved text", () => {
    using captured = captureLogsForTestingOnly("capture-test");

    logger.debug("lazy", () => ["built", { n: 1 }]);
    logger.info("plain", "said");
    logger.warn("failed", new Error("broke"));
    logger.error("plain", "again");

    expect(captured.logs).toEqual([
      {
        level: "debug",
        key: "lazy",
        text: "built { n: 1 }",
        messages: ["built", { n: 1 }],
      },
      { level: "info", key: "plain", text: "said", messages: ["said"] },
      {
        level: "warn",
        key: "failed",
        text: "broke",
        messages: [new Error("broke")],
      },
      { level: "error", key: "plain", text: "again", messages: ["again"] },
    ]);
    expect(captured.textsOf("plain")).toEqual(["said", "again"]);
    expect(printed.calls).toEqual([]);
  });

  it("keeps each line's messages as they were, not rendered", () => {
    using captured = captureLogsForTestingOnly("capture-test");
    const error = new Error("broke");
    const detail = { n: 1 };

    logger.warn("failed", error, detail);

    const { text, messages } = captured.logs[0]!;
    expect(text).toBe("broke { n: 1 }");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(error);
    expect(messages[1]).toBe(detail);
  });

  it("resolves `first()` at once with the first line already logged under the key", async () => {
    using captured = captureLogsForTestingOnly("capture-test");

    logger.info("early", "first");
    logger.info("early", "second");

    expect((await captured.first("early")).text).toBe("first");
    expect((await captured.first("early")).text).toBe("first");
  });

  it("resolves `first()` when the logger logs the key, not for another key", async () => {
    using captured = captureLogsForTestingOnly("capture-test");
    let resolved = false;
    const waiting = captured.first("later").then((log) => {
      resolved = true;
      return log;
    });

    logger.info("elsewhere", "not this one");
    await Promise.resolve();
    expect(resolved).toBe(false);

    logger.info("later", "this one");
    logger.info("later", "and again");
    expect((await waiting).text).toBe("this one");
  });

  it("rejects a pending `first()` naming its key once disposed, leaving a settled one resolved", async () => {
    const captured = captureLogsForTestingOnly("capture-test");
    logger.info("logged", "here");
    const settled = captured.first("logged");
    const pending = captured.first("never");

    captured[Symbol.dispose]();

    expect((await settled).text).toBe("here");
    await expect(pending).rejects.toThrow(
      'The capture of "capture-test" ended before a line was logged under "never".',
    );
  });

  it("rejects `first()` at once on a disposed capture without the key, and resolves it with one", async () => {
    const captured = captureLogsForTestingOnly("capture-test");
    logger.info("logged", "here");
    captured[Symbol.dispose]();

    expect((await captured.first("logged")).text).toBe("here");
    await expect(captured.first("never")).rejects.toThrow(
      'The capture of "capture-test" ended before a line was logged under "never".',
    );
  });

  it("leaves another logger's lines to reach `console`", () => {
    using captured = captureLogsForTestingOnly("capture-test");

    other.debug("elsewhere", "printed");

    expect(captured.logs).toEqual([]);
    expect(printed.calls.map((call) => call.args.slice(2))).toEqual([
      ["elsewhere", "printed"],
    ]);
  });

  it("throws for a logger already being captured, leaving the first capture recording", () => {
    using captured = captureLogsForTestingOnly("capture-test");

    expect(() => captureLogsForTestingOnly("capture-test")).toThrow(
      'The logger "capture-test" is already being captured.',
    );
    logger.info("plain", "kept");

    expect(captured.textsOf("plain")).toEqual(["kept"]);
  });

  it("leaves out the count summary of a logger past its threshold", () => {
    // Calls are counted while the logger is disabled, so these carry its total
    // to the default threshold of 100 without printing the summary, and the
    // first line under the capture carries it past.
    const counted = getLogger("capture-test-counted");
    counted.disabled = true;
    for (let i = 0; i < 100; i++) counted.debug("quiet", "dropped");
    using captured = captureLogsForTestingOnly("capture-test-counted");

    counted.info("real", "line");
    counted.debug("real", "again");

    expect(counted.counts.total).toBe(102);
    expect(captured.logs).toEqual([
      { level: "info", key: "real", text: "line", messages: ["line"] },
      { level: "debug", key: "real", text: "again", messages: ["again"] },
    ]);
    expect(printed.calls).toEqual([]);
  });

  describe("under `LOG_TO_STDERR`", () => {
    let written: Stub<typeof Deno.stderr>;

    beforeEach(() => {
      Deno.env.set("LOG_TO_STDERR", "1");
      written = stub(Deno.stderr, "writeSync", (bytes) => bytes.length);
    });

    afterEach(() => written.restore());

    it("records the lines the logger would write to stderr", () => {
      using captured = captureLogsForTestingOnly("capture-test");

      logger.warn("failed", "loudly");

      expect(captured.logs).toEqual([
        { level: "warn", key: "failed", text: "loudly", messages: ["loudly"] },
      ]);
      expect(written.calls).toEqual([]);
    });

    it("leaves another logger writing to stderr", () => {
      using _captured = captureLogsForTestingOnly("capture-test");

      other.warn("elsewhere", "written");

      expect(
        written.calls.map((call) =>
          new TextDecoder().decode(call.args[0]).trimEnd()
        ),
      ).toEqual([expect.stringMatching(/ elsewhere written$/)]);
    });
  });

  it("keeps the floor lifted until the last of overlapping captures ends, in either order", () => {
    const first = captureLogsForTestingOnly("capture-test");
    const second = captureLogsForTestingOnly("capture-test-other");

    first[Symbol.dispose]();
    expect(getGlobalLogFloor()).toBeUndefined();
    other.info("plain", "still recorded");
    expect(second.textsOf("plain")).toEqual(["still recorded"]);

    second[Symbol.dispose]();
    expect(getGlobalLogFloor()).toBe("error");
  });

  it("puts back the logger and the global floor, and stops recording, once disposed", () => {
    const captured = captureLogsForTestingOnly("capture-test");
    captured[Symbol.dispose]();

    expect(logger.disabled).toBe(true);
    expect(logger.level).toBe("error");
    expect(getGlobalLogFloor()).toBe("error");
    logger.disabled = false;
    logger.level = "debug";
    setGlobalLogFloor(undefined);
    logger.debug("after", "printed");
    expect(captured.logs).toEqual([]);
    expect(printed.calls.map((call) => call.args.slice(2))).toEqual([
      ["after", "printed"],
    ]);
  });
});

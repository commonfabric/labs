import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { getLogger } from "@commonfabric/logger";

import type {
  IMemorySpaceAddress,
  MemorySpace,
} from "../../src/storage/interface.ts";
import {
  getWriteStackTrace,
  recordWriteStackTrace,
  setWriteStackTraceMatchers,
  type WriteStackTraceMatcher,
} from "../../src/storage/write-stack-trace.ts";

const space: MemorySpace = "did:key:z6Mk-write-stack-trace";
const otherSpace: MemorySpace = "did:key:z6Mk-write-stack-trace-other";
const scopeId = "write-stack-trace-test";

const at = (
  path: string[],
  options: { space?: MemorySpace; id?: `${string}:${string}` } = {},
): IMemorySpaceAddress => ({
  space: options.space ?? space,
  id: options.id ?? "of:traced",
  type: "application/json",
  path: ["value", ...path],
});

/** Watches with `matchers`, records a write to each of `paths`, and returns
 * the logical paths the trace kept. */
const tracedPaths = (
  matchers: WriteStackTraceMatcher[],
  writes: IMemorySpaceAddress[],
): string[][] => {
  setWriteStackTraceMatchers(matchers, { scopeId });
  for (const address of writes) {
    recordWriteStackTrace(address, 1, { scopeId });
  }
  return getWriteStackTrace({ scopeId }).map((entry) => entry.path);
};

/** Runs `body` with the engine reporting an empty stack for every error. */
const withNoStack = (body: () => void): void => {
  const ErrorWithHook = Error as ErrorConstructor & {
    prepareStackTrace?: unknown;
  };
  const original = ErrorWithHook.prepareStackTrace;
  ErrorWithHook.prepareStackTrace = () => "";
  try {
    body();
  } finally {
    ErrorWithHook.prepareStackTrace = original;
  }
};

describe("write-stack-trace", () => {
  afterEach(() => {
    setWriteStackTraceMatchers([], { scopeId });
  });

  describe("recordWriteStackTrace()", () => {
    it("records only a write at the very path an exact matcher names", () => {
      expect(tracedPaths(
        [{ path: ["a"] }],
        [at(["a"]), at(["a", "b"]), at([])],
      )).toEqual([["a"]]);
    });

    it("records a write at or beneath the path a prefix matcher names, and none above it", () => {
      expect(tracedPaths(
        [{ path: ["a", "b"], match: "prefix" }],
        [at(["a"]), at(["a", "b"]), at(["a", "b", "c"]), at(["a", "c"])],
      )).toEqual([["a", "b"], ["a", "b", "c"]]);
    });

    it("records only writes in the space and document a matcher names", () => {
      expect(tracedPaths(
        [{ space, entityId: "of:traced", path: [], match: "prefix" }],
        [
          at(["in"]),
          at(["other-space"], { space: otherSpace }),
          at(["other-document"], { id: "of:untraced" }),
        ],
      )).toEqual([["in"]]);
    });

    it("records the kind of value each write carried", () => {
      setWriteStackTraceMatchers([{ path: ["a"] }], { scopeId });
      const values = [undefined, null, true, 1, "s", [1], { a: 1 }, () => 1];
      for (const value of values) {
        recordWriteStackTrace(at(["a"]), value, { scopeId });
      }
      expect(getWriteStackTrace({ scopeId }).map((entry) => entry.valueKind))
        .toEqual([
          "undefined",
          "null",
          "boolean",
          "number",
          "string",
          "array",
          "object",
          "other",
        ]);
    });

    it("keeps the latest 400 entries, dropping the earliest", () => {
      setWriteStackTraceMatchers([{ path: [], match: "prefix" }], { scopeId });
      for (let i = 0; i < 402; i++) {
        recordWriteStackTrace(at([String(i)]), i, { scopeId });
      }
      const paths = getWriteStackTrace({ scopeId }).map((entry) =>
        entry.path[0]
      );
      expect(paths.length).toBe(400);
      expect(paths[0]).toBe("2");
      expect(paths.at(-1)).toBe("401");
    });

    it("records the writing stack, and no stack where the engine reports none", () => {
      setWriteStackTraceMatchers([{ path: ["a"] }], { scopeId });
      recordWriteStackTrace(at(["a"]), 1, { scopeId });

      withNoStack(() => recordWriteStackTrace(at(["a"]), 1, { scopeId }));

      const [withStack, withoutStack] = getWriteStackTrace({ scopeId });
      expect(withStack.stack).toContain("write-stack-trace.test.ts");
      expect(withoutStack.stack).toBeUndefined();
    });

    it("warns with the matcher's label, the address, the writer, and the result when its logger is enabled", () => {
      setWriteStackTraceMatchers([{ path: ["a"], label: "watched title" }], {
        scopeId,
      });
      const logger = getLogger("storage.write-trace");
      const disabled = logger.disabled;
      const warn = console.warn;
      const warned: unknown[][] = [];
      logger.disabled = false;
      console.warn = (...args: unknown[]) => warned.push(args);
      try {
        recordWriteStackTrace(at(["a"]), 1, {
          scopeId,
          writerActionId: "action:writer",
          errorName: "WriteError",
        });
        recordWriteStackTrace(at(["a"]), 1, { scopeId });
        withNoStack(() => recordWriteStackTrace(at(["a"]), 1, { scopeId }));
      } finally {
        console.warn = warn;
        logger.disabled = disabled;
      }

      const lines = warned.map((args) => args.slice(3));
      expect(lines[0].slice(0, 4)).toEqual([
        "Matched watched title",
        `${space}/of:traced/a`,
        "Writer: action:writer",
        "Result: error (WriteError)",
      ]);
      expect(lines[1].slice(0, 3)).toEqual([
        "Matched watched title",
        `${space}/of:traced/a`,
        "Result: ok",
      ]);
      expect(String(lines[1][3])).toContain("write-stack-trace.test.ts");
      expect(lines[2].slice(2)).toEqual(["Result: ok", "(no stack available)"]);
    });
  });
});

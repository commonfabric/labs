import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CompilerError } from "@commonfabric/js-compiler/errors";
import { isPlainObject } from "@commonfabric/js-values/types";

import {
  decodeCompileFailure,
  decodeCompileWorkerAnswer,
  decodeCompileWorkerRequest,
  encodeCompileFailure,
} from "../../src/harness/compile-worker-protocol.ts";
import type { ModuleCompileRequest } from "../../src/harness/module-compile.ts";

const REQUEST: ModuleCompileRequest = {
  program: {
    main: "/main.ts",
    files: [{ name: "/main.ts", contents: "export const x = 1;" }],
  },
  authoredSources: [{ name: "/main.ts", contents: "export const x = 1;" }],
  id: "program-id",
  mounts: [{
    entryIdentity: "entry-identity",
    entryPath: "/~cf/mount/main.ts",
    specifiers: ["fabric:entry-identity"],
  }],
  moduleIdentities: new Map([["/main.ts", "main-identity"]]),
  specifierAliases: new Map([["fabric:entry-identity", "/~cf/mount/main.ts"]]),
  storedSource: false,
  noCheck: true,
  diagnosticMessages: "reactive",
  instanceNames: false,
};

const DIAGNOSTICS = {
  timeOrigin: 1000,
  loggerCounts: {
    compiler: {
      compile: { debug: 1, info: 2, warn: 3, error: 4, total: 10 },
    },
  },
  timingStats: {
    compiler: {
      phase: {
        count: 2,
        min: 1,
        max: 3,
        totalTime: 4,
        average: 2,
        countSinceBaseline: 1,
        totalTimeSinceBaseline: 3,
        averageSinceBaseline: 3,
        p50: 2,
        p95: 3,
        lastTime: 3,
        lastTimestamp: 50,
        slowest: [
          { elapsed: 3, at: 50, epochMs: 1050, detail: "/main.ts" },
          { elapsed: 1, at: 20, epochMs: 1020 },
        ],
        cdf: [{ x: 1, y: 0.5 }, { x: 3, y: 1 }],
        cdfSinceBaseline: [{ x: 3, y: 1 }],
      },
    },
  },
};

const COMPILED = {
  kind: "compiled",
  id: 7,
  modules: [["/main.ts", {
    js: "exports.x = 1;",
    sourceMap: '{"version":3,"sources":[],"names":[],"mappings":""}',
    builderSourceSites: {
      formatVersion: 1,
      sites: { __cfLift_1: { line: 1, col: 0 } },
    },
    policyManifests: [{ policy: "manifest" }],
  }]],
  diagnostics: DIAGNOSTICS,
};

const FAILED_IN_COMPILER = {
  kind: "failed",
  id: 8,
  failure: {
    kind: "compiler",
    errors: [{
      source: "export const x: string = 1;",
      file: "/main.ts",
      line: 1,
      column: 14,
      message: "Type 'number' is not assignable to type 'string'.",
      type: "ERROR",
    }, { message: "Cannot find module 'nowhere'.", type: "MODULE_NOT_FOUND" }],
  },
  diagnostics: DIAGNOSTICS,
};

const FAILED_IN_TRANSFORMER = {
  kind: "failed",
  id: 9,
  failure: {
    kind: "transformer",
    diagnostics: [{
      severity: "error",
      type: "pattern:shape",
      message: "A pattern returns no record.",
      fileName: "/main.ts",
      line: 1,
      column: 0,
      start: 0,
      length: 6,
    }],
  },
  diagnostics: DIAGNOSTICS,
};

const FAILED_OTHERWISE = {
  kind: "failed",
  id: 10,
  failure: {
    kind: "error",
    name: "RangeError",
    message: "too far",
    stack: "RangeError: too far\n    at somewhere",
  },
  diagnostics: DIAGNOSTICS,
};

/**
 * `value` with what sits at the dotted `path` replaced by `replacement`,
 * leaving `value` itself as it was. A path step into a list is its index.
 */
function replacing(
  value: unknown,
  path: string,
  replacement: unknown,
): unknown {
  if (path === "") return replacement;
  const [head, ...rest] = path.split(".");
  const inner = (from: unknown) => replacing(from, rest.join("."), replacement);
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      index === Number(head) ? inner(entry) : entry
    );
  }
  if (isPlainObject(value)) return { ...value, [head]: inner(value[head]) };
  throw new Error(`No step "${head}" in the fixture`);
}

describe("compile-worker-protocol", () => {
  describe("encodeCompileFailure()", () => {
    it("encodes an ordinary error's name, message and stack", () => {
      const error = new RangeError("too far");

      expect(encodeCompileFailure(error)).toEqual({
        kind: "error",
        name: "RangeError",
        message: "too far",
        stack: error.stack,
      });
    });

    it("encodes no stack for an error that has none", () => {
      const error = new Error("no trace");
      error.stack = undefined;

      expect(encodeCompileFailure(error)).toStrictEqual({
        kind: "error",
        name: "Error",
        message: "no trace",
      });
    });

    it("encodes a thrown value that is not an error as an `Error` naming it", () => {
      expect(encodeCompileFailure("the compiler gave up")).toEqual({
        kind: "error",
        name: "Error",
        message: "the compiler gave up",
      });
    });

    it("encodes a `CompilerError` as its errors, not as an ordinary error", () => {
      const fields = {
        source: "const label: string = 1;",
        file: "/main.tsx",
        line: 3,
        column: 9,
        message: "Type 'number' is not assignable to type 'string'.",
        type: "ERROR",
      } as const;

      expect(encodeCompileFailure(new CompilerError([fields]))).toEqual({
        kind: "compiler",
        errors: [fields],
      });
    });
  });

  describe("decodeCompileFailure()", () => {
    it("rebuilds an ordinary error with the name, message and stack it was encoded with", () => {
      const original = new RangeError("too far");

      const rebuilt = decodeCompileFailure(
        encodeCompileFailure(original),
        REQUEST,
      );

      expect(rebuilt).not.toBeInstanceOf(CompilerError);
      expect(rebuilt.name).toBe("RangeError");
      expect(rebuilt.message).toBe("too far");
      expect(rebuilt.stack).toBe(original.stack);
    });

    it("gives the rebuilt error a stack of its own where none was encoded", () => {
      const rebuilt = decodeCompileFailure(
        { kind: "error", name: "Error", message: "no trace" },
        REQUEST,
      );

      expect(rebuilt.message).toBe("no trace");
      expect(rebuilt.stack).toContain("no trace");
    });
  });

  describe("decodeCompileWorkerRequest()", () => {
    it("returns the request a structured clone carried", () => {
      const sent = { id: 3, request: REQUEST };

      expect(decodeCompileWorkerRequest(structuredClone(sent))).toEqual(sent);
    });

    it("returns a request with no `/<id>` prefix as having none", () => {
      const { id: _, ...unprefixed } = REQUEST;

      const decoded = decodeCompileWorkerRequest({
        id: 3,
        request: unprefixed,
      });

      expect("id" in decoded.request).toBe(false);
      expect(decoded.request.program).toEqual(REQUEST.program);
    });

    it("throws for a message with no request id", () => {
      expect(() => decodeCompileWorkerRequest({ request: REQUEST })).toThrow(
        "A compile worker received a message with no request id",
      );
      expect(() => decodeCompileWorkerRequest("compile")).toThrow(
        "A compile worker received a message with no request id",
      );
    });

    const malformed: readonly (readonly [string, unknown, string])[] = [
      ["request", 1, "a request that is not a record"],
      ["request.program", [], "a request whose program has no entry"],
      ["request.program.main", 1, "a request whose program has no entry"],
      [
        "request.diagnosticMessages",
        "loud",
        "a request with no diagnostic message style",
      ],
      ["request.program.files", {}, "program files that are not a list"],
      ["request.program.files.0", "/main.ts", "a source that is not a record"],
      ["request.program.files.0.contents", 1, "no string `contents`"],
      ["request.authoredSources.0.name", null, "no string `name`"],
      ["request.id", 1, "no string `id`"],
      ["request.mounts.0", "fabric:entry", "a mount that is not a record"],
      ["request.mounts.0.entryIdentity", 1, "no string `entryIdentity`"],
      ["request.mounts.0.entryPath", 1, "no string `entryPath`"],
      [
        "request.mounts.0.specifiers",
        "x",
        "mount specifiers that are not a list",
      ],
      [
        "request.mounts.0.specifiers.0",
        1,
        "a string list entry that is not a string",
      ],
      [
        "request.moduleIdentities",
        { "/main.ts": "main-identity" },
        "module identities that are not a map",
      ],
      [
        "request.specifierAliases",
        new Map([["fabric:entry-identity", 1]]),
        "specifier aliases with an entry that is not two strings",
      ],
      [
        "request.moduleIdentities",
        new Map([[1, "main-identity"]]),
        "module identities with an entry that is not two strings",
      ],
      ["request.storedSource", undefined, "no boolean `storedSource`"],
      ["request.noCheck", "yes", "no boolean `noCheck`"],
      ["request.instanceNames", 0, "no boolean `instanceNames`"],
    ];
    for (const [path, replacement, carried] of malformed) {
      it(
        `throws, saying it carried ${carried}, for \`${path}\` replaced by ${
          Deno.inspect(replacement)
        }`,
        () => {
          const sent = replacing(
            { id: 3, request: REQUEST },
            path,
            replacement,
          );

          expect(() => decodeCompileWorkerRequest(sent)).toThrow(
            `The compile worker protocol carried ${carried}`,
          );
        },
      );
    }
  });

  describe("decodeCompileWorkerAnswer()", () => {
    it("returns `ready` for a ready answer", () => {
      expect(decodeCompileWorkerAnswer({ kind: "ready" })).toEqual({
        kind: "ready",
      });
    });

    for (
      const [what, answer] of [
        ["modules", COMPILED],
        ["a compiler's failure", FAILED_IN_COMPILER],
        ["a transformer's failure", FAILED_IN_TRANSFORMER],
        ["an ordinary error", FAILED_OTHERWISE],
      ] as const
    ) {
      it(`returns an answer carrying ${what} as it was sent`, () => {
        expect(decodeCompileWorkerAnswer(structuredClone(answer))).toEqual(
          answer,
        );
      });
    }

    it("returns an answer with no baseline CDF, no source map and no detail as it was sent", () => {
      const sparse = replacing(
        replacing(
          replacing(
            COMPILED,
            "diagnostics.timingStats.compiler.phase.cdfSinceBaseline",
            null,
          ),
          "modules.0.1",
          { js: "exports.x = 1;" },
        ),
        "diagnostics.timingStats.compiler.phase.slowest",
        [{ elapsed: 1, at: 20, epochMs: 1020 }],
      );

      expect(decodeCompileWorkerAnswer(sparse)).toStrictEqual(sparse);
    });

    it("returns a failure with no stack as having none", () => {
      const answer = replacing(FAILED_OTHERWISE, "failure.stack", undefined);

      const decoded = decodeCompileWorkerAnswer(answer);

      expect(decoded.kind === "failed" && "stack" in decoded.failure).toBe(
        false,
      );
      expect(decoded).toEqual(answer);
    });

    it("throws for an answer that is not a record", () => {
      expect(() => decodeCompileWorkerAnswer("ready")).toThrow(
        "The compile worker protocol carried an answer that is not a record",
      );
    });

    const malformed: readonly (readonly [
      { readonly kind: string },
      string,
      unknown,
      string,
    ])[] = [
      [COMPILED, "id", "7", "an answer with no request id"],
      [COMPILED, "kind", "done", "an answer of no known kind"],
      [
        COMPILED,
        "diagnostics",
        [],
        "worker diagnostics that are not a record",
      ],
      [COMPILED, "diagnostics.timeOrigin", "0", "no number `timeOrigin`"],
      [
        COMPILED,
        "diagnostics.loggerCounts",
        1,
        "log counts that are not a record",
      ],
      [
        COMPILED,
        "diagnostics.loggerCounts.compiler",
        1,
        "a logger's log counts that are not a record",
      ],
      [
        COMPILED,
        "diagnostics.loggerCounts.compiler.compile",
        1,
        "log counts for a key that are not a record",
      ],
      [
        COMPILED,
        "diagnostics.loggerCounts.compiler.compile.warn",
        "3",
        "no number `warn`",
      ],
      [
        COMPILED,
        "diagnostics.timingStats",
        null,
        "timing statistics that are not a record",
      ],
      [
        COMPILED,
        "diagnostics.timingStats.compiler",
        1,
        "a logger's timing statistics that are not a record",
      ],
      [
        COMPILED,
        "diagnostics.timingStats.compiler.phase",
        1,
        "timing statistics for a key that are not a record",
      ],
      [
        COMPILED,
        "diagnostics.timingStats.compiler.phase.p95",
        undefined,
        "no number `p95`",
      ],
      [
        COMPILED,
        "diagnostics.timingStats.compiler.phase.slowest",
        {},
        "slowest timings that are not a list",
      ],
      [
        COMPILED,
        "diagnostics.timingStats.compiler.phase.slowest.0",
        3,
        "a slow timing that is not a record",
      ],
      [
        COMPILED,
        "diagnostics.timingStats.compiler.phase.slowest.0.detail",
        3,
        "no string `detail`",
      ],
      [
        COMPILED,
        "diagnostics.timingStats.compiler.phase.cdf.0",
        [1, 0.5],
        "a CDF point that is not a record",
      ],
      [
        COMPILED,
        "diagnostics.timingStats.compiler.phase.cdfSinceBaseline",
        undefined,
        "CDF points that are not a list",
      ],
      [
        COMPILED,
        "diagnostics.timingStats.compiler.phase.cdfSinceBaseline.0.y",
        "1",
        "no number `y`",
      ],
      [COMPILED, "modules", {}, "modules that are not a list"],
      [
        COMPILED,
        "modules.0",
        ["/main.ts"],
        "a module entry that is not a pair",
      ],
      [
        COMPILED,
        "modules.0",
        "/main.ts",
        "a module entry that is not a pair",
      ],
      [
        COMPILED,
        "modules.0.0",
        1,
        "a module entry with no name or no module",
      ],
      [
        COMPILED,
        "modules.0.1",
        "exports.x = 1;",
        "a module entry with no name or no module",
      ],
      [
        COMPILED,
        "modules.0.1.builderSourceSites",
        { formatVersion: 2, sites: {} },
        "a module whose builder source sites do not decode",
      ],
      [
        COMPILED,
        "modules.0.1.policyManifests",
        { policy: "manifest" },
        "a module whose policy manifests are not a list",
      ],
      [COMPILED, "modules.0.1.js", undefined, "no string `js`"],
      [COMPILED, "modules.0.1.sourceMap", {}, "no string `sourceMap`"],
      [
        FAILED_OTHERWISE,
        "failure",
        "too far",
        "a failure that is not a record",
      ],
      [FAILED_OTHERWISE, "failure.kind", "panic", "a failure of no known kind"],
      [FAILED_OTHERWISE, "failure.name", 1, "no string `name`"],
      [FAILED_OTHERWISE, "failure.stack", [], "no string `stack`"],
      [
        FAILED_OTHERWISE,
        "diagnostics",
        undefined,
        "worker diagnostics that are not a record",
      ],
      [
        FAILED_IN_COMPILER,
        "failure.errors",
        {},
        "compile errors that are not a list",
      ],
      [
        FAILED_IN_COMPILER,
        "failure.errors.0",
        "Type error",
        "a compile error that is not a record",
      ],
      [
        FAILED_IN_COMPILER,
        "failure.errors.0.type",
        "WARNING",
        "a compile error of no known type",
      ],
      [FAILED_IN_COMPILER, "failure.errors.0.line", "1", "no number `line`"],
      [
        FAILED_IN_COMPILER,
        "failure.errors.1.message",
        undefined,
        "no string `message`",
      ],
      [
        FAILED_IN_TRANSFORMER,
        "failure.diagnostics.0",
        "A pattern returns no record.",
        "a transformer diagnostic that is not a record",
      ],
      [
        FAILED_IN_TRANSFORMER,
        "failure.diagnostics.0.severity",
        "info",
        "a transformer diagnostic of no known severity",
      ],
      [
        FAILED_IN_TRANSFORMER,
        "failure.diagnostics.0.length",
        null,
        "no number `length`",
      ],
    ];
    for (const [answer, path, replacement, carried] of malformed) {
      it(
        `throws, saying it carried ${carried}, for \`${path}\` of a \`${answer.kind}\` answer replaced by ${
          Deno.inspect(replacement)
        }`,
        () => {
          expect(() =>
            decodeCompileWorkerAnswer(replacing(answer, path, replacement))
          ).toThrow(`The compile worker protocol carried ${carried}`);
        },
      );
    }
  });
});

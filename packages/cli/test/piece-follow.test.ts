/**
 * Drives the `cf piece follow` action body and the lib function in-process
 * with a stubbed connection, so the transition the piece controller makes —
 * a `repoint` to the origin the caller named — and the outcomes the action
 * reports are covered without a server.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";

import { PieceSourceChangedError } from "@commonfabric/piece/ops";
import {
  FOLLOW_PIN_REFUSED_EXIT_CODE,
  followPieceSourceAction,
  parsePatternPin,
  parseRevisionPin,
} from "../commands/piece.ts";
import { followPieceSource, type PieceConfig } from "../lib/piece.ts";
import { argv, cf, stripAnsi } from "./utils.ts";

const BASE_OPTIONS = {
  apiUrl: "http://127.0.0.1:8000",
  identity: "/nonexistent-but-unread.key",
  space: "did:key:zSpace",
  cell: "of:profile",
};

describe("cf piece follow", () => {
  it("accepts explicit confirmation while still requiring a source origin", async () => {
    const result = await cf(
      argv`piece follow --dangerously-allow-incompatible-schema
        --identity /nonexistent-but-unread.key --space did:key:zSpace
        --cell of:profile --api-url http://127.0.0.1:8000 ${"   "}`,
    );
    expect(result.code).toBe(1);
    expect(stripAnsi(result.stdout.join("\n"))).toContain(
      "cf piece follow <origin>",
    );
    expect(stripAnsi(result.stderr.join("\n"))).toContain(
      "An origin is required.",
    );
  });

  describe("followPieceSource()", () => {
    it("refuses a deployment that serves piece lifecycle verbs", async () => {
      const config: PieceConfig = {
        apiUrl: BASE_OPTIONS.apiUrl,
        identity: BASE_OPTIONS.identity,
        space: BASE_OPTIONS.space,
        piece: "of:profile",
      };
      const served = {
        runtime: { experimental: { serverExecution: true } },
        get: () => {
          throw new Error("must not reach the client-side repoint");
        },
      };
      await expect(followPieceSource(config, "system:system/x.tsx", {}, {
        // deno-lint-ignore no-explicit-any
        loadPieces: () => Promise.resolve(served as any),
      })).rejects.toThrow(/not served yet/);
    });

    it("repoints the resolved piece at the origin and reports the transition", async () => {
      const actions: unknown[] = [];
      const config: PieceConfig = {
        apiUrl: BASE_OPTIONS.apiUrl,
        identity: BASE_OPTIONS.identity,
        space: BASE_OPTIONS.space,
        piece: "of:profile",
      };
      const pieces = {
        get: (id: string) =>
          Promise.resolve({
            id,
            changeSource: (action: unknown) => {
              actions.push(action);
              return Promise.resolve({ status: "applied" as const });
            },
          }),
      };
      const result = await followPieceSource(
        config,
        "system:system/profile-home.tsx",
        {},
        {
          // deno-lint-ignore no-explicit-any
          loadPieces: () => Promise.resolve(pieces as any),
          resolvePieceAddress: () => Promise.resolve("of:profile"),
        },
      );
      expect(result).toEqual({ status: "applied" });
      expect(actions).toEqual([
        { kind: "repoint", url: "system:system/profile-home.tsx" },
      ]);
    });

    it("passes both pins to the review and to its confirmation", async () => {
      const calls: unknown[][] = [];
      const pattern = { identity: "abc", symbol: "default" };
      const controller = {
        changeSource: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve(
            calls.length === 1
              ? {
                status: "incompatible" as const,
                message: "result.x: field removed",
                prepared: { review: "candidate" },
              }
              : { status: "applied" as const },
          );
        },
      };
      await followPieceSource(
        { ...BASE_OPTIONS, piece: "of:profile" },
        "system:fabrichat/room.tsx",
        {
          dangerouslyAllowIncompatibleSchema: true,
          expectedPattern: pattern,
          expectedRevision: null,
        },
        {
          // deno-lint-ignore no-explicit-any
          loadPieces: () =>
            Promise.resolve({ get: () => Promise.resolve(controller) } as any),
          resolvePieceAddress: () => Promise.resolve("of:profile"),
        },
      );
      expect(calls.map((call) => call[1])).toEqual([
        { expectedPattern: pattern, expectedRevision: null },
        {
          expectedPattern: pattern,
          expectedRevision: null,
          confirmedChange: { review: "candidate" },
        },
      ]);
    });
  });

  describe("parsePatternPin()", () => {
    it("returns the identity and symbol of a pin written as inspect prints it", () => {
      expect(parsePatternPin("cf:module/abc#default")).toEqual({
        identity: "abc",
        symbol: "default",
      });
      expect(parsePatternPin("abc#Room")).toEqual({
        identity: "abc",
        symbol: "Room",
      });
    });

    it("throws a `ValidationError` for a pin with no symbol", () => {
      expect(() => parsePatternPin("abc")).toThrow(ValidationError);
      expect(() => parsePatternPin("abc#")).toThrow(ValidationError);
    });
  });

  describe("parseRevisionPin()", () => {
    it("returns `null` for none and the revision id otherwise", () => {
      expect(parseRevisionPin("none")).toBeNull();
      expect(parseRevisionPin(" r-1 ")).toBe("r-1");
    });
  });

  describe("explicit compatibility confirmation", () => {
    for (const allow of [false, true]) {
      for (const changesDuringConfirmation of [false, true]) {
        it(`confirms ${allow ? "once" : "zero times"} when the retained input ${changesDuringConfirmation ? "changes" : "stays fixed"}`, async () => {
          const calls: unknown[][] = [];
          // The controller owns this opaque review; the CLI must forward it
          // unchanged rather than construct a second approval.
          const prepared = { review: "first candidate" };
          const incompatible = {
            status: "incompatible" as const,
            message: "result.inbox.space: existing result field was removed",
            prepared,
          };
          const changed = {
            ...incompatible,
            prepared: { review: "changed candidate" },
          };
          const controller = {
            changeSource: (...args: unknown[]) => {
              calls.push(args);
              return Promise.resolve(
                calls.length === 1
                  ? incompatible
                  : changesDuringConfirmation
                  ? changed
                  : { status: "applied" as const },
              );
            },
          };
          const result = await followPieceSource(
            { ...BASE_OPTIONS, piece: "of:profile" },
            "system:system/profile-home.tsx",
            { dangerouslyAllowIncompatibleSchema: allow },
            {
              // Only the connection boundary is stubbed; calls above measure
              // which review the real CLI implementation confirms.
              // deno-lint-ignore no-explicit-any
              loadPieces: () =>
                Promise.resolve(
                  { get: () => Promise.resolve(controller) } as any,
                ),
              resolvePieceAddress: () => Promise.resolve("of:profile"),
            },
          );
          expect(calls.length).toBe(allow ? 2 : 1);
          expect(result).toEqual(
            !allow ? incompatible : changesDuringConfirmation ? changed : {
              status: "applied",
              acceptedIncompatibility: incompatible.message,
            },
          );
          if (allow) {
            expect(calls[1][0]).toEqual(calls[0][0]);
            expect(calls[1][1]).toEqual({ confirmedChange: prepared });
            expect(
              (calls[1][1] as { confirmedChange: unknown }).confirmedChange,
            ).toBe(prepared);
          }
        });
      }
    }
  });

  describe("followPieceSourceAction()", () => {
    for (const warning of [undefined, "refresh failed"]) {
      it(`reports the incompatibility accepted in this invocation${warning ? " even when refresh fails" : ""}`, async () => {
        const rendered: unknown[] = [];
        const errors: string[] = [];
        const codes: number[] = [];
        await followPieceSourceAction(
          { ...BASE_OPTIONS, dangerouslyAllowIncompatibleSchema: true },
          "system:system/profile-home.tsx",
          {
            followPieceSource: () =>
              Promise.resolve({
                status: "applied",
                acceptedIncompatibility: "result.inbox.host: field removed",
                executionWarning: warning,
              }),
            render: (value) => rendered.push(value),
            hint: () => {},
            printError: (value) => errors.push(value),
            setExitCode: (code) => codes.push(code),
          },
        );
        expect(rendered).toEqual([
          "Accepted incompatibility: result.inbox.host: field removed",
          "of:profile now follows system:system/profile-home.tsx",
        ]);
        expect(codes).toEqual(warning ? [1] : []);
        expect(errors).toEqual(
          warning
            ? [
              "The follow committed, but refreshing the running piece failed: refresh failed",
            ]
            : [],
        );
      });
    }

    it("reports a follow that landed", async () => {
      const rendered: unknown[] = [];
      const hints: string[] = [];
      await followPieceSourceAction(
        { ...BASE_OPTIONS, dangerouslyAllowIncompatibleSchema: true },
        " system:system/profile-home.tsx ",
        {
          followPieceSource: (config, origin, options) => {
            expect(options?.dangerouslyAllowIncompatibleSchema).toBe(true);
            expect(config.piece).toBe("of:profile");
            expect(origin).toBe("system:system/profile-home.tsx");
            return Promise.resolve({ status: "applied" });
          },
          render: (value) => rendered.push(value),
          hint: (message) => hints.push(message),
        },
      );
      expect(rendered).toEqual([
        "of:profile now follows system:system/profile-home.tsx",
      ]);
      expect(hints.join("\n")).toContain("cf piece inspect");
    });

    it("reports an incompatible candidate with its message and a non-zero exit", async () => {
      const codes: number[] = [];
      const rendered: unknown[] = [];
      const errors: string[] = [];
      await followPieceSourceAction(BASE_OPTIONS, "system:system/x.tsx", {
        followPieceSource: () =>
          Promise.resolve({
            status: "incompatible",
            message: "argument.name: newly required argument field",
            // deno-lint-ignore no-explicit-any
            prepared: {} as any,
          }),
        render: (value) => rendered.push(value),
        printError: (message) => errors.push(message),
        setExitCode: (code) => codes.push(code),
      });
      expect(codes).toEqual([1]);
      expect(rendered).toEqual([]);
      expect(errors).toEqual([
        "The source system:system/x.tsx serves now cannot replace what " +
        "of:profile runs: argument.name: newly required argument field",
        "Review the incompatibility before retrying with " +
        "--dangerously-allow-incompatible-schema. Existing links may no " +
        "longer fit the new pattern.",
      ]);
    });

    it("reports a follow whose piece did not come back up, with a non-zero exit", async () => {
      const codes: number[] = [];
      const errors: string[] = [];
      const rendered: unknown[] = [];
      await followPieceSourceAction(BASE_OPTIONS, "system:system/x.tsx", {
        followPieceSource: () =>
          Promise.resolve({
            status: "applied",
            executionWarning: "injected post-commit failure",
          }),
        render: (value) => rendered.push(value),
        printError: (message) => errors.push(message),
        setExitCode: (code) => codes.push(code),
      });
      expect(rendered).toEqual(["of:profile now follows system:system/x.tsx"]);
      expect(errors).toEqual([
        "The follow committed, but refreshing the running piece failed: " +
        "injected post-commit failure",
      ]);
      expect(codes).toEqual([1]);
    });

    it("pins the follow to the pattern and source log the flags name", async () => {
      let pins: unknown;
      await followPieceSourceAction(
        {
          ...BASE_OPTIONS,
          expect: "cf:module/abc#default",
          expectRevision: "none",
        },
        "system:fabrichat/room.tsx",
        {
          followPieceSource: (_config, _origin, options) => {
            pins = options;
            return Promise.resolve({ status: "applied" });
          },
          render: () => {},
          hint: () => {},
        },
      );
      expect(pins).toEqual({
        dangerouslyAllowIncompatibleSchema: undefined,
        expectedPattern: { identity: "abc", symbol: "default" },
        expectedRevision: null,
      });
    });

    it("ends with exit status 3 and renders nothing for a piece off its pin", async () => {
      const codes: number[] = [];
      const rendered: unknown[] = [];
      const errors: string[] = [];
      await followPieceSourceAction(
        { ...BASE_OPTIONS, expectRevision: "none" },
        "system:fabrichat/room.tsx",
        {
          followPieceSource: () =>
            Promise.reject(
              new PieceSourceChangedError("The piece's source log moved."),
            ),
          render: (value) => rendered.push(value),
          printError: (message) => errors.push(message),
          setExitCode: (code) => codes.push(code),
        },
      );
      expect(codes).toEqual([FOLLOW_PIN_REFUSED_EXIT_CODE]);
      expect(FOLLOW_PIN_REFUSED_EXIT_CODE).toBe(3);
      expect(rendered).toEqual([]);
      expect(errors).toEqual([
        "of:profile was not pointed at system:fabrichat/room.tsx: " +
        "The piece's source log moved.",
      ]);
    });

    it("throws a `ValidationError` for a blank origin", async () => {
      await expect(
        followPieceSourceAction(BASE_OPTIONS, "   ", {
          followPieceSource: () => {
            throw new Error("must not connect");
          },
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});

/**
 * The driver's side of the command channel, run against a stand-in keyboard
 * and a stand-in for settling a command in the page.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type KeyPresser,
  pressOn,
  runCommand,
  type SettleResult,
} from "../driver-commands.ts";

/** A keyboard that logs each call, failing the press of `failOn`. */
function loggingKeyboard(
  failOn?: string,
): { keyboard: KeyPresser; log: string[] } {
  const log: string[] = [];
  const keyboard: KeyPresser = {
    down: (key) => {
      log.push(`down ${key}`);
      return Promise.resolve();
    },
    up: (key) => {
      log.push(`up ${key}`);
      return Promise.resolve();
    },
    press: (key) => {
      log.push(`press ${key}`);
      return key === failOn
        ? Promise.reject(new Error(`${key} jammed`))
        : Promise.resolve();
    },
  };
  return { keyboard, log };
}

/** A settler that records each call and comes back with `result`. */
function recordingSettle(result: () => Promise<SettleResult>) {
  const calls: [number, string | null][] = [];
  return {
    calls,
    settle: (id: number, error: string | null) => {
      calls.push([id, error]);
      return result();
    },
  };
}

const SETTLED: SettleResult = {};

describe("driver-commands", () => {
  describe("pressOn()", () => {
    it("holds the modifiers down around the key, releasing them in reverse", async () => {
      const { keyboard, log } = loggingKeyboard();
      await pressOn(keyboard, { press: "Tab", modifiers: ["Shift", "Alt"] });
      expect(log).toEqual([
        "down Shift",
        "down Alt",
        "press Tab",
        "up Alt",
        "up Shift",
      ]);
    });

    it("releases the modifiers when the press fails", async () => {
      const { keyboard, log } = loggingKeyboard("Enter");
      await expect(
        pressOn(keyboard, { press: "Enter", modifiers: ["Control"] }),
      ).rejects.toThrow("Enter jammed");
      expect(log).toEqual(["down Control", "press Enter", "up Control"]);
    });
  });

  describe("runCommand()", () => {
    it("presses the key and settles the command with no error", async () => {
      const { keyboard, log } = loggingKeyboard();
      const { calls, settle } = recordingSettle(() => Promise.resolve(SETTLED));
      const report = await runCommand(
        JSON.stringify({ id: 4, press: "Tab", modifiers: ["Shift"] }),
        keyboard,
        settle,
      );
      expect(report).toBeUndefined();
      expect(log).toEqual(["down Shift", "press Tab", "up Shift"]);
      expect(calls).toEqual([[4, null]]);
    });

    it("settles a refused key with why, pressing nothing", async () => {
      const { keyboard, log } = loggingKeyboard();
      const { calls, settle } = recordingSettle(() => Promise.resolve(SETTLED));
      const report = await runCommand(
        JSON.stringify({ id: 5, press: "Space" }),
        keyboard,
        settle,
      );
      expect(report).toBeUndefined();
      expect(log).toEqual([]);
      expect(calls).toEqual([[5, "`Space` is not a key a test may press"]]);
    });

    it("settles a press the keyboard fails with why", async () => {
      const { keyboard } = loggingKeyboard("Enter");
      const { calls, settle } = recordingSettle(() => Promise.resolve(SETTLED));
      await runCommand(
        JSON.stringify({ id: 6, press: "Enter" }),
        keyboard,
        settle,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(6);
      expect(calls[0][1]).toContain("Enter jammed");
    });

    it("reports a command with no id, settling nothing", async () => {
      for (const payload of ['{"press":"Tab"}', "not json", "7"]) {
        const { keyboard, log } = loggingKeyboard();
        const { calls, settle } = recordingSettle(() =>
          Promise.resolve(SETTLED)
        );
        expect(await runCommand(payload, keyboard, settle)).toBe(
          `A test sent a command with no id: \`${payload}\``,
        );
        expect(log).toEqual([]);
        expect(calls).toEqual([]);
      }
    });

    it("reports a command whose document is gone", async () => {
      const { keyboard } = loggingKeyboard();
      const { settle } = recordingSettle(() => Promise.resolve(undefined));
      expect(
        await runCommand('{"id":8,"press":"Tab"}', keyboard, settle),
      ).toBe(
        "Command 8 could not be settled: the document that sent it is gone",
      );
    });

    it("reports what the settler threw in the page", async () => {
      const { keyboard } = loggingKeyboard();
      const thrown = recordingSettle(() =>
        Promise.resolve({
          exceptionDetails: {
            exception: { description: "TypeError: not a function" },
            text: "Uncaught",
          },
        })
      );
      expect(
        await runCommand('{"id":9,"press":"Tab"}', keyboard, thrown.settle),
      ).toBe("Command 9 could not be settled: TypeError: not a function");

      const undescribed = recordingSettle(() =>
        Promise.resolve({ exceptionDetails: { text: "Uncaught" } })
      );
      expect(
        await runCommand(
          '{"id":10,"press":"Tab"}',
          keyboard,
          undescribed.settle,
        ),
      ).toBe("Command 10 could not be settled: Uncaught");
    });

    it("reports a settler that rejects, rather than rejecting", async () => {
      const { keyboard } = loggingKeyboard();
      const { settle } = recordingSettle(() =>
        Promise.reject(new Error("connection closed"))
      );
      const report = await runCommand(
        '{"id":11,"press":"Tab"}',
        keyboard,
        settle,
      );
      expect(report).toMatch(/^Command 11 could not be settled: /);
      expect(report).toContain("connection closed");
    });
  });
});

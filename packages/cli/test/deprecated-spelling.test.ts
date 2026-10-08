import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  COMMAND_SPELLING_END_DATE,
  commandSpellingNotice,
  noCommandSpellingNotice,
  warnDeprecatedCommandSpelling,
} from "../lib/deprecated-spelling.ts";

describe("deprecated-spelling", () => {
  describe("COMMAND_SPELLING_END_DATE", () => {
    it("is a fixed calendar day", () => {
      expect(COMMAND_SPELLING_END_DATE).toBe("2026-09-11");
    });

    it("reads the same however long apart two callers see it", () => {
      // The guarantee is that the date does not move with the clock, so the
      // check is that the same notice text comes back under two different
      // wall-clock readings rather than that two adjacent calls agree.
      const lines: string[] = [];
      const write = (text: string) => lines.push(text);
      const realNow = Date.now;
      try {
        Date.now = () => new Date("2026-09-01T00:00:00Z").getTime();
        warnDeprecatedCommandSpelling("view", "source view", {
          writeError: write,
        });
        Date.now = () => new Date("2026-12-25T00:00:00Z").getTime();
        warnDeprecatedCommandSpelling("view", "source view", {
          writeError: write,
        });
      } finally {
        Date.now = realNow;
      }
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(lines[1]);
      expect(lines[0]).toContain("2026-09-11");
    });
  });

  describe("warnDeprecatedCommandSpelling()", () => {
    it("names the spelling written, the spelling to write, and the end date", () => {
      // Asserted as one exact string rather than as several `toContain`
      // fragments. Two fragments that happen to hold the same words survive a
      // rename sweep that collapses them into one, and the test then passes
      // while pinning nothing; a whole-message comparison fails loudly
      // instead.
      const lines: string[] = [];
      warnDeprecatedCommandSpelling(
        "piece recreate-root",
        "space recreate-root",
        { writeError: (text) => lines.push(text) },
      );
      expect(lines).toEqual([
        "'cf piece recreate-root' is deprecated; spell it " +
        "'cf space recreate-root'. The 'cf piece recreate-root' spelling is " +
        "not guaranteed to work after 2026-09-11.",
      ]);
    });

    it("names the two spellings separately when one contains the other", () => {
      // The superseded spelling is a suffix of its replacement here, which is
      // the case where a notice that printed one word twice would still read
      // plausibly.
      const lines: string[] = [];
      warnDeprecatedCommandSpelling("get", "cell get", {
        writeError: (text) => lines.push(text),
      });
      expect(lines).toEqual([
        "'cf get' is deprecated; spell it 'cf cell get'. The 'cf get' " +
        "spelling is not guaranteed to work after 2026-09-11.",
      ]);
    });

    it("writes to stderr and puts nothing on stdout", () => {
      // stdout carries machine-readable output on several of the commands
      // this notice is mounted under, so a notice there would corrupt it.
      const errors: string[] = [];
      const out: string[] = [];
      const realError = console.error;
      const realLog = console.log;
      try {
        console.error = (text: string) => errors.push(text);
        console.log = (text: string) => out.push(text);
        warnDeprecatedCommandSpelling("check", "source check");
      } finally {
        console.error = realError;
        console.log = realLog;
      }
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("'cf check' is deprecated");
      expect(out).toEqual([]);
    });
  });

  describe("commandSpellingNotice()", () => {
    it("emits the notice before running the action", () => {
      const events: string[] = [];
      const realError = console.error;
      try {
        console.error = () => events.push("notice");
        const wrapped = commandSpellingNotice("acl ls", "space acl ls")
          .action(() => {
            events.push("action");
          });
        wrapped();
      } finally {
        console.error = realError;
      }
      expect(events).toEqual(["notice", "action"]);
    });

    it("returns what the action returns", () => {
      const realError = console.error;
      try {
        console.error = () => {};
        const wrapped = commandSpellingNotice("view", "source view")
          .action((n: number) => n * 2);
        expect(wrapped(21)).toBe(42);
      } finally {
        console.error = realError;
      }
    });

    it("passes its arguments through in order", () => {
      const seen: unknown[] = [];
      const realError = console.error;
      try {
        console.error = () => {};
        const wrapped = commandSpellingNotice("view", "source view")
          .action((...args: unknown[]) => {
            for (const arg of args) seen.push(arg);
          });
        wrapped({ json: true }, "first", "second");
      } finally {
        console.error = realError;
      }
      expect(seen).toEqual([{ json: true }, "first", "second"]);
    });

    it("keeps the action's `this` binding", () => {
      // A callable command's action reads `this.getLiteralArgs()`, so a
      // wrapper that dropped the receiver would break the words after `--`.
      const realError = console.error;
      try {
        console.error = () => {};
        const wrapped = commandSpellingNotice("call", "piece call")
          .action(function (this: { literalArgs: string[] }) {
            return this.literalArgs;
          });
        const receiver = { literalArgs: ["a", "b"], run: wrapped };
        expect(receiver.run()).toEqual(["a", "b"]);
      } finally {
        console.error = realError;
      }
    });

    it("gives a help page the notice after the page it asked for", () => {
      // `--help` renders and exits before any action, so the page is the only
      // place a caller who is only asking what the command is gets told.
      const events: string[] = [];
      const realError = console.error;
      try {
        console.error = () => events.push("notice");
        const command = commandSpellingNotice("get", "cell get").helpPage({
          showHelp: () => events.push("page"),
        });
        command.showHelp();
      } finally {
        console.error = realError;
      }
      expect(events).toEqual(["page", "notice"]);
    });

    it("hands the help page the options it was called with", () => {
      // Cliffy's own help action passes `{ long }`, and a page rendered
      // without it is a different page.
      const seen: unknown[] = [];
      const realError = console.error;
      try {
        console.error = () => {};
        const command = commandSpellingNotice("get", "cell get").helpPage({
          showHelp: (options?: unknown) => seen.push(options),
        });
        command.showHelp({ long: true });
      } finally {
        console.error = realError;
      }
      expect(seen).toEqual([{ long: true }]);
    });

    it("says the notice once when a run reaches both the action and the page", () => {
      // The line cliffy answers with both: an action that throws a validation
      // error is followed by the command's help page. Told twice, a caller
      // learns to skim it.
      const notices: string[] = [];
      const realError = console.error;
      try {
        console.error = (text: string) => notices.push(text);
        const notice = commandSpellingNotice("set", "cell set");
        const command = notice.helpPage({ showHelp: () => {} });
        notice.action(() => {})();
        command.showHelp();
      } finally {
        console.error = realError;
      }
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("'cf set' is deprecated");
    });

    it("leaves a blessed mount's action and help page silent", () => {
      // The same builder is mounted twice, and only the superseded mount
      // carries a notice — a canonical spelling that warned about itself
      // would tell every caller to stop writing the right thing.
      const events: string[] = [];
      const realError = console.error;
      try {
        console.error = (text: string) => events.push(text);
        const command = noCommandSpellingNotice.helpPage({
          showHelp: () => events.push("page"),
        });
        noCommandSpellingNotice.action(() => events.push("action"))();
        command.showHelp();
      } finally {
        console.error = realError;
      }
      expect(events).toEqual(["action", "page"]);
    });
  });
});

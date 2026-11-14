import { join } from "@std/path";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Key } from "../lib/view/keys.ts";
import { realPushIo } from "../lib/view/push.ts";
import { cursorScreenPos } from "../lib/view/render.ts";
import { helpOverlay, Session } from "../lib/view/session.ts";
import {
  readSettings,
  saveSettings,
  type ViewSettings,
} from "../lib/view/settings.ts";
import { cellOf, drawnRows, mouseKey, parseDocument } from "./view-helpers.ts";

const RELAY = "github-webhooks.example.test:8081";

const OFF: ViewSettings = { quitOnPullRequest: false, webhookRelay: "" };

const ON: ViewSettings = { quitOnPullRequest: true, webhookRelay: RELAY };

const decoder = new TextDecoder();

/**
 * A repository whose git reads only the user configuration file in `root`,
 * and the query that runs git there.
 */
function repository() {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  const env = {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  };
  Deno.writeTextFileSync(env.GIT_CONFIG_GLOBAL, "");
  const work = join(root, "work");
  new Deno.Command("git", {
    args: ["init", "--quiet", work],
    env,
    clearEnv: true,
  }).outputSync();
  Deno.mkdirSync(join(work, "sub"));
  const git = realPushIo({ cwd: work, env, write() {} }).query;
  /** The query that runs git in a directory inside the work tree. */
  const gitInSub = realPushIo({ cwd: join(work, "sub"), env, write() {} })
    .query;
  /** What the configuration file of `scope` sets, one `name=value` a line. */
  const file = (scope: "global" | "local") =>
    decoder.decode(
      new Deno.Command("git", {
        args: ["config", `--${scope}`, "--list"],
        cwd: work,
        env,
        clearEnv: true,
        stdout: "piped",
      }).outputSync().stdout,
    );
  return { root, git, gitInSub, file };
}

/** A session over a small file, on an 80 by 24 screen. */
function session(): Session {
  return new Session(
    parseDocument("const a = 1;\n"),
    { color: false, showLineNumbers: false },
    { width: 80, height: 24 },
  );
}

/** A session with the settings dialog up, showing `settings`. */
function settingsSession(settings: ViewSettings = OFF): Session {
  const s = session();
  s.openSettings(settings);
  return s;
}

/** The key that types `char`. */
function typed(char: string): Key {
  return { name: char, char };
}

describe("settings", () => {
  describe("readSettings()", () => {
    it("returns everything off and empty when git's configuration sets nothing", () => {
      const { root, git } = repository();
      try {
        expect(readSettings(git)).toEqual(OFF);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("reads any spelling git accepts for true", () => {
      const { root, git } = repository();
      try {
        git(["config", "--global", "cf-view.quitOnPullRequest", "yes"]);
        git(["config", "--global", "cf-view.webhookRelay", ` ${RELAY} `]);

        expect(readSettings(git)).toEqual(ON);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });
  });

  describe("saveSettings()", () => {
    it("saves settings nothing set in the user's own configuration", () => {
      const { root, git, file } = repository();
      try {
        expect(saveSettings(git, OFF, ON)).toBe(true);

        expect(readSettings(git)).toEqual(ON);
        expect(file("global")).toBe(
          `cf-view.quitonpullrequest=true\ncf-view.webhookrelay=${RELAY}\n`,
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("saves a setting in the repository's configuration when that is where it was read from", () => {
      const { root, git, file } = repository();
      try {
        git(["config", "--local", "cf-view.webhookRelay", "old.test:1"]);

        expect(saveSettings(git, OFF, ON)).toBe(true);

        expect(file("local")).toContain(`cf-view.webhookrelay=${RELAY}\n`);
        expect(file("global")).toBe("cf-view.quitonpullrequest=true\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("saves a setting in the repository's configuration from a directory inside its work tree", () => {
      const { root, git, gitInSub, file } = repository();
      try {
        git(["config", "--local", "cf-view.webhookRelay", "old.test:1"]);

        expect(saveSettings(gitInSub, OFF, { ...OFF, webhookRelay: RELAY }))
          .toBe(true);

        expect(file("local")).toContain(`cf-view.webhookrelay=${RELAY}\n`);
        expect(file("global")).toBe("");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("saves a setting in the file a configuration file includes when that is where it was read from", () => {
      const { root, git } = repository();
      try {
        const included = join(root, "included settings");
        Deno.writeTextFileSync(
          included,
          "[cf-view]\n\twebhookRelay = old.test:1\n",
        );
        git(["config", "--local", "include.path", included]);

        expect(saveSettings(git, OFF, { ...OFF, webhookRelay: RELAY }))
          .toBe(true);

        expect(readSettings(git).webhookRelay).toBe(RELAY);
        expect(Deno.readTextFileSync(included)).toContain(RELAY);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("saves a setting read from the machine's configuration, or from no file, in the user's", () => {
      for (
        const origin of [
          "system\0file:/etc/gitconfig\0old\0",
          "command\0command line:\0old\0",
        ]
      ) {
        const ran: string[] = [];
        const git = (args: readonly string[]) => {
          ran.push(args.join(" "));
          return args.includes("--show-origin") ? origin : "";
        };

        expect(saveSettings(git, OFF, { ...OFF, webhookRelay: RELAY }))
          .toBe(true);

        expect(ran.at(-1)).toBe(
          `config --global cf-view.webhookRelay ${RELAY}`,
        );
      }
    });

    it("writes nothing for settings that have not changed from those shown, whatever git now holds", () => {
      const { root, git, file } = repository();
      try {
        git(["config", "--global", "cf-view.webhookRelay", "other.test:1"]);

        expect(saveSettings(git, ON, ON)).toBe(true);

        expect(file("global")).toBe("cf-view.webhookrelay=other.test:1\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("tries every setting, and returns false, when git cannot save one", () => {
      const ran: string[] = [];
      const git = (args: readonly string[]) => {
        ran.push(args.join(" "));
        return null;
      };

      expect(saveSettings(git, OFF, ON)).toBe(false);
      expect(ran.filter((command) => command.startsWith("config --global")))
        .toEqual([
          "config --global cf-view.quitOnPullRequest true",
          `config --global cf-view.webhookRelay ${RELAY}`,
        ]);
    });
  });

  describe("the settings dialog", () => {
    it("is asked for by `O`", () => {
      const s = session();

      s.handleKey(typed("O"));

      expect(s.settingsRequested).toBe(true);
      expect(s.view().dialog).toBeNull();
    });

    it("shows the settings as a check box and an input line, with the check box focused", () => {
      const s = settingsSession(ON);

      const dialog = s.view().dialog!;
      expect(dialog.title).toBe("Settings");
      expect(dialog.fields).toEqual([
        {
          kind: "checkBox",
          label: "Quit when the pushed branch's pull request opens",
          hotkey: "q",
          checked: true,
        },
        {
          kind: "inputLine",
          label: "Webhook relay (host:port)",
          hotkey: "w",
          value: RELAY,
          cursor: RELAY.length,
          scroll: 0,
          selected: false,
        },
      ]);
      expect(dialog.fieldFocus).toBe(0);
      expect(dialog.buttons.map((b) => b.label)).toEqual(["OK", "Cancel"]);
      expect(dialog.focus).toBe(0);
    });

    it("draws the check box as Turbo Vision does, and the input line under its label", () => {
      const s = settingsSession(OFF);
      const unchecked = drawnRows(s);
      s.handleKey({ name: "space", char: " " });
      const checked = drawnRows(s);

      const box = cellOf(unchecked, "[ ] Quit when");
      expect(cellOf(checked, "[X] Quit when")).toEqual(box);
      const label = cellOf(unchecked, "Webhook relay (host:port)");
      expect(label).toEqual({ x: box.x, y: box.y + 2 });
      expect(cellOf(unchecked, " OK ").y).toBe(label.y + 3);
    });

    it("toggles the check box with Space, and with its letter", () => {
      const s = settingsSession(OFF);

      s.handleKey({ name: "space", char: " " });
      expect(s.view().dialog!.fields![0]).toMatchObject({ checked: true });
      s.handleKey(typed("Q"));
      expect(s.view().dialog!.fields![0]).toMatchObject({ checked: false });
      s.handleKey(typed("q"));

      s.handleKey({ name: "enter" });
      expect(s.settingsToSave).toEqual({
        shown: OFF,
        settings: { ...OFF, quitOnPullRequest: true },
      });
      expect(s.view().dialog).toBeNull();
    });

    it("moves the focus through the fields and then the buttons with Tab and Shift-Tab", () => {
      const s = settingsSession();
      const focus = () => {
        const dialog = s.view().dialog!;
        return [dialog.fieldFocus, dialog.focus];
      };

      const seen = [focus()];
      for (let i = 0; i < 4; i++) {
        s.handleKey({ name: "tab" });
        seen.push(focus());
      }
      s.handleKey({ name: "shift-tab" });
      seen.push(focus());

      expect(seen).toEqual([
        [0, 0],
        [1, 0],
        [-1, 0],
        [-1, 1],
        [0, 0],
        [-1, 1],
      ]);
    });

    it("selects the input line's text when the focus moves to it, so that typing replaces it", () => {
      const s = settingsSession({ ...OFF, webhookRelay: "old.test:1" });

      s.handleKey({ name: "tab" });
      expect(s.view().dialog!.fields![1]).toMatchObject({ selected: true });
      s.handleKey({ name: "tab" });
      expect(s.view().dialog!.fields![1]).toMatchObject({ selected: false });
      s.handleKey({ name: "shift-tab" });
      for (const char of RELAY) s.handleKey(typed(char));
      s.handleKey({ name: "enter" });

      expect(s.settingsToSave?.settings).toEqual({
        ...OFF,
        webhookRelay: RELAY,
      });
    });

    it("types into the focused input line, letters and navigation keys included, and saves what it holds, trimmed", () => {
      const s = settingsSession({ ...OFF, webhookRelay: "x" });
      s.handleKey({ name: "tab" });

      s.handleKey({ name: "end" });
      s.handleKey({ name: "backspace" });
      for (const char of ` ${RELAY.slice(0, -1)}jkgoqc`) {
        s.handleKey(char === " " ? { name: "space", char } : typed(char));
      }
      for (let i = 0; i < 6; i++) s.handleKey({ name: "backspace" });
      s.handleKey({ name: "left" });
      s.handleKey({ name: "right" });
      s.handleKey(typed("1"));
      s.handleKey({ name: "enter" });

      expect(s.settingsToSave?.settings).toEqual({
        ...OFF,
        webhookRelay: RELAY,
      });
    });

    it("keeps the focus on the input line for keys that move it elsewhere in other dialogs", () => {
      const s = settingsSession({ ...OFF, webhookRelay: RELAY });
      s.handleKey({ name: "tab" });
      s.handleKey({ name: "end" });

      for (
        const name of ["up", "down", "pagedown", "pageup", "ctrl-u", "ctrl-n"]
      ) {
        s.handleKey({ name });
        expect(s.view().dialog!.fieldFocus).toBe(1);
      }
      s.handleKey({ name: "enter" });

      expect(s.settingsToSave?.settings).toEqual({
        ...OFF,
        webhookRelay: RELAY,
      });
    });

    it("focuses the input line with its letter from the check box, and activates a button with Alt and its letter from the input line", () => {
      const s = settingsSession(OFF);

      s.handleKey(typed("w"));
      expect(s.view().dialog!.fieldFocus).toBe(1);
      expect(s.view().dialog!.fields![1]).toMatchObject({ selected: true });
      s.handleKey(typed("c"));
      s.handleKey({ name: "c", alt: true });

      expect(s.view().dialog).toBeNull();
      expect(s.settingsToSave).toBeNull();
    });

    it("closes without saving on Escape", () => {
      const s = settingsSession(OFF);
      s.handleKey({ name: "space", char: " " });

      s.handleKey({ name: "escape" });

      expect(s.view().dialog).toBeNull();
      expect(s.settingsToSave).toBeNull();
    });

    it("toggles the check box when the mouse comes up on it after going down on it, and not otherwise", () => {
      const s = settingsSession(OFF);
      const box = cellOf(drawnRows(s), "[ ] Quit");
      const label = cellOf(drawnRows(s), "Webhook relay");

      s.handleKey(mouseKey(true, box));
      s.handleKey(mouseKey(false, label));
      expect(s.view().dialog!.fields![0]).toMatchObject({ checked: false });
      s.handleKey(mouseKey(true, box));
      s.handleKey(mouseKey(false, { ...box, x: box.x + 10 }));
      expect(s.view().dialog!.fields![0]).toMatchObject({ checked: true });
    });

    it("focuses the input line on a click on it, puts its cursor where the click lands, and saves on a click on OK", () => {
      const s = settingsSession({ ...OFF, webhookRelay: "ab" });
      const text = cellOf(drawnRows(s), "ab");

      s.handleKey(mouseKey(true, { ...text, x: text.x + 1 }));
      s.handleKey(mouseKey(false, { ...text, x: text.x + 1 }));
      expect(s.view().dialog!.fieldFocus).toBe(1);
      s.handleKey(typed("r"));
      s.handleKey(mouseKey(true, { ...text, x: text.x - 2 }));
      s.handleKey(typed("<"));
      s.handleKey(mouseKey(true, { ...text, x: text.x + 30 }));
      s.handleKey(typed(">"));
      const ok = cellOf(drawnRows(s), " OK ");
      s.handleKey(mouseKey(true, ok));
      expect(s.view().dialog!.pushed).toBe(0);
      s.handleKey(mouseKey(false, ok));

      expect(s.settingsToSave?.settings).toEqual({
        ...OFF,
        webhookRelay: "<arb>",
      });
    });

    it("selects the input line's text on a click on its label", () => {
      const s = settingsSession({ ...OFF, webhookRelay: "old.test:1" });
      const label = cellOf(drawnRows(s), "Webhook relay");

      s.handleKey(mouseKey(true, label));
      s.handleKey(mouseKey(false, label));

      expect(s.view().dialog!.fieldFocus).toBe(1);
      expect(s.view().dialog!.fields![1]).toMatchObject({ selected: true });
    });

    it("keeps text under the pointer on a click in an input line narrowed to fit the terminal", () => {
      const long = `${"x".repeat(55)}abcde`;
      const s = session();
      s.resize(40, 24);
      s.openSettings({ ...OFF, webhookRelay: long });
      s.handleKey({ name: "tab" });
      const before = drawnRows(s);
      const at = cellOf(before, "abcde");

      s.handleKey(mouseKey(true, at));
      s.handleKey(mouseKey(false, at));
      s.handleKey(typed("|"));

      expect(cellOf(drawnRows(s), "|abcde")).toEqual(at);
      s.handleKey({ name: "enter" });
      expect(s.settingsToSave?.settings.webhookRelay).toBe(
        `${"x".repeat(55)}|abcde`,
      );
    });

    it("does nothing on a click below a dialog too short to draw its fields and buttons", () => {
      const s = session();
      s.resize(80, 7);
      s.openSettings(OFF);
      const rows = drawnRows(s);

      for (let y = 0; y < rows.length; y++) {
        s.handleKey(mouseKey(true, { x: 40, y }));
        s.handleKey(mouseKey(false, { x: 40, y }));
      }

      expect(s.view().dialog!.fieldFocus).not.toBe(1);
      expect(rows.join("\n")).not.toContain("Webhook relay");
      expect(cursorScreenPos(s.displayDoc(), s.view())).toBeNull();
    });

    it("puts the terminal's cursor in the focused input line, and nowhere while the check box is focused", () => {
      const s = settingsSession({ ...OFF, webhookRelay: "abc" });
      expect(cursorScreenPos(s.displayDoc(), s.view())).toBeNull();

      s.handleKey({ name: "tab" });
      s.handleKey({ name: "left" });

      const text = cellOf(drawnRows(s), "abc");
      expect(s.view().dialog!.fields![1]).toMatchObject({ selected: false });
      expect(cursorScreenPos(s.displayDoc(), s.view())).toEqual({
        row: text.y + 1,
        col: text.x + 3,
      });
    });

    it("shows the end of text wider than the input line, with an arrow saying more precedes it", () => {
      const long = `${"x".repeat(60)}:8081`;
      const s = settingsSession({ ...OFF, webhookRelay: long });
      s.handleKey({ name: "tab" });

      const rows = drawnRows(s);
      const shown = cellOf(rows, ":8081");
      expect(rows[shown.y]).toMatch(/◄x+:8081 /);
      expect(rows[shown.y]).not.toContain("►");
      expect(cursorScreenPos(s.displayDoc(), s.view())).toEqual({
        row: shown.y + 1,
        col: shown.x + 6,
      });

      s.handleKey({ name: "home" });
      const start = drawnRows(s);
      expect(start[shown.y]).toMatch(/ x{50}►/);
    });

    it("lists `O` in the help", () => {
      expect(helpOverlay(false).info.map((line) => line.text)).toContain(
        "  O".padEnd(22) +
          " settings: quit when the pushed branch's pull request opens",
      );
    });
  });
});

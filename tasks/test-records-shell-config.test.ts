import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { Environment } from "@commonfabric/test-support/records";

import {
  effectiveValue,
  exportFromProfiles,
  exportLine,
  homeRelative,
  MARKER,
  parseSetting,
  profileCandidates,
  profilesToInspect,
  reexportFromProfiles,
  reloadHint,
  shellKind,
  stripMarkedBlock,
  unexportFromProfiles,
} from "./test-records-shell-config.ts";

const VARIABLE = "CF_TEST_RECORDS_KEY_FILE";

function environment(values: Record<string, string>): Environment {
  return (name) => values[name];
}

describe("test-records-shell-config", () => {
  let home: string;
  let KEY_PATH: string;

  beforeEach(async () => {
    home = await Deno.makeTempDir({ prefix: "test-records-profile-" });
    KEY_PATH = join(home, "k.json");
  });

  afterEach(async () => {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  });

  describe("shellKind()", () => {
    it("returns the family named by SHELL", () => {
      expect(shellKind(environment({ SHELL: "/bin/zsh" }))).toBe("zsh");
      expect(shellKind(environment({ SHELL: "/usr/bin/bash" }))).toBe("bash");
      expect(shellKind(environment({ SHELL: "/opt/homebrew/bin/fish" })))
        .toBe("fish");
    });

    it("returns posix for an unset or unfamiliar shell", () => {
      expect(shellKind(environment({}))).toBe("posix");
      expect(shellKind(environment({ SHELL: "/bin/ksh" }))).toBe("posix");
    });
  });

  describe("profileCandidates()", () => {
    it("returns the zsh profile every shell reads, under ZDOTDIR", () => {
      expect(
        profileCandidates(
          environment({ SHELL: "/bin/zsh", HOME: "/h", ZDOTDIR: "/z" }),
          "linux",
        ),
      ).toEqual(["/z/.zshenv"]);
    });

    it("returns the home zsh profile without ZDOTDIR", () => {
      expect(
        profileCandidates(environment({ SHELL: "/bin/zsh", HOME: "/h" })),
      ).toEqual(["/h/.zshenv"]);
    });

    it("orders the bash profiles by the ones the platform reads first", () => {
      const env = environment({ SHELL: "/bin/bash", HOME: "/h" });
      expect(profileCandidates(env, "darwin")).toEqual([
        "/h/.bash_profile",
        "/h/.bashrc",
      ]);
      expect(profileCandidates(env, "linux")).toEqual([
        "/h/.bashrc",
        "/h/.bash_profile",
      ]);
    });

    it("returns the fish configuration under the configuration home", () => {
      expect(
        profileCandidates(
          environment({
            SHELL: "/bin/fish",
            HOME: "/h",
            XDG_CONFIG_HOME: "/c",
          }),
        ),
      ).toEqual(["/c/fish/config.fish"]);
      expect(
        profileCandidates(environment({ SHELL: "/bin/fish", HOME: "/h" })),
      ).toEqual(["/h/.config/fish/config.fish"]);
    });

    it("returns the shared profile for anything else", () => {
      expect(profileCandidates(environment({ HOME: "/h" }))).toEqual([
        "/h/.profile",
      ]);
    });

    it("returns nothing without a home directory", () => {
      expect(profileCandidates(environment({ SHELL: "/bin/zsh" }))).toEqual([]);
    });
  });

  describe("profilesToInspect()", () => {
    it("returns every zsh profile read after the one written", () => {
      expect(profilesToInspect(environment({ SHELL: "/bin/zsh", HOME: "/h" })))
        .toEqual(["/h/.zprofile", "/h/.zshrc", "/h/.zlogin"]);
    });

    it("returns nothing for a shell with one profile", () => {
      expect(profilesToInspect(environment({ SHELL: "/bin/bash", HOME: "/h" })))
        .toEqual([]);
      expect(profilesToInspect(environment({ HOME: "/h" }))).toEqual([]);
    });
  });

  describe("exportLine()", () => {
    it("returns an export for posix shells", () => {
      expect(exportLine("zsh", VARIABLE, "/k.json")).toBe(
        `export ${VARIABLE}="/k.json"`,
      );
    });

    it("returns a global set for fish", () => {
      expect(exportLine("fish", VARIABLE, "/k.json")).toBe(
        `set -gx ${VARIABLE} "/k.json"`,
      );
    });

    it("writes a path under the home directory through $HOME", () => {
      expect(exportLine("zsh", VARIABLE, "/h/.config/k.json", "/h")).toBe(
        `export ${VARIABLE}="$HOME/.config/k.json"`,
      );
    });

    it("escapes what a shell would otherwise act on", () => {
      expect(exportLine("zsh", VARIABLE, '/h/$(id)/`id`/"q"/b\\s/k.json', "/h"))
        .toBe(
          `export ${VARIABLE}=` +
            '"$HOME/\\$(id)/\\`id\\`/\\"q\\"/b\\\\s/k.json"',
        );
    });

    it("escapes for fish, which has no backtick", () => {
      expect(exportLine("fish", VARIABLE, "/h/$(id)/`id`/k.json", "/h")).toBe(
        `set -gx ${VARIABLE} "$HOME/\\$(id)/\`id\`/k.json"`,
      );
    });
  });

  describe("effectiveValue()", () => {
    it("returns the path a value naming $HOME stands for", () => {
      expect(effectiveValue('"$HOME/.config/k.json"', "/h")).toBe(
        "/h/.config/k.json",
      );
      expect(effectiveValue("${HOME}/k.json", "/h")).toBe("/h/k.json");
    });

    it("holds a single-quoted value literally", () => {
      expect(effectiveValue("'$HOME/k.json'", "/h")).toBe("$HOME/k.json");
    });

    it("holds an escaped dollar sign literally", () => {
      expect(effectiveValue('"\\$HOME/k.json"', "/h")).toBe("$HOME/k.json");
    });

    it("returns a name that only starts like $HOME unchanged", () => {
      expect(effectiveValue("$HOMEBREW/k.json", "/h")).toBe("$HOMEBREW/k.json");
      expect(effectiveValue("$HOME/k.json", undefined)).toBe("$HOME/k.json");
    });

    it("drops a comment that follows the value", () => {
      expect(effectiveValue('"/k.json" # the reporting key', "/h")).toBe(
        "/k.json",
      );
      expect(effectiveValue('"/a#b.json"', "/h")).toBe("/a#b.json");
    });
  });

  describe("homeRelative()", () => {
    it("returns a path under the home directory through $HOME", () => {
      expect(homeRelative("/h/.config/k.json", "/h")).toBe(
        "$HOME/.config/k.json",
      );
      expect(homeRelative("/h/.config/k.json", "/h/")).toBe(
        "$HOME/.config/k.json",
      );
    });

    it("returns a path outside the home directory unchanged", () => {
      expect(homeRelative("/etc/k.json", "/h")).toBe("/etc/k.json");
      expect(homeRelative("/home2/k.json", "/h")).toBe("/home2/k.json");
      expect(homeRelative("/h/k.json", undefined)).toBe("/h/k.json");
    });
  });

  describe("parseSetting()", () => {
    it("returns the value an export carries", () => {
      expect(parseSetting(`export ${VARIABLE}="/k.json"\n`, VARIABLE)).toEqual({
        line: `export ${VARIABLE}="/k.json"`,
        exported: true,
        value: "/k.json",
      });
    });

    it("reports an assignment that is never exported", () => {
      expect(parseSetting(`${VARIABLE}=/k.json\n`, VARIABLE)).toEqual({
        line: `${VARIABLE}=/k.json`,
        exported: false,
        value: "/k.json",
      });
    });

    it("reads a fish set with no flags as not exported", () => {
      expect(parseSetting(`set ${VARIABLE} "/k.json"\n`, VARIABLE)).toEqual({
        line: `set ${VARIABLE} "/k.json"`,
        exported: false,
        value: "/k.json",
      });
    });

    it("reads fish's set, exported only with -x", () => {
      expect(parseSetting(`set -gx ${VARIABLE} "/k.json"\n`, VARIABLE)).toEqual(
        {
          line: `set -gx ${VARIABLE} "/k.json"`,
          exported: true,
          value: "/k.json",
        },
      );
      expect(parseSetting(`set -g ${VARIABLE} "/k.json"\n`, VARIABLE)?.exported)
        .toBe(false);
    });

    it("takes one level of quoting off the value", () => {
      expect(parseSetting(`export ${VARIABLE}='/k.json'\n`, VARIABLE)?.value)
        .toBe("/k.json");
      expect(
        parseSetting(`export ${VARIABLE}="/a\\$b/k.json"\n`, VARIABLE)?.value,
      ).toBe("/a$b/k.json");
    });

    it("reports fish's --unexport as not exported", () => {
      expect(
        parseSetting(`set --unexport ${VARIABLE} "/k.json"\n`, VARIABLE)
          ?.exported,
      ).toBe(false);
      expect(
        parseSetting(`set --export ${VARIABLE} "/k.json"\n`, VARIABLE)
          ?.exported,
      ).toBe(true);
      expect(
        parseSetting(`set -gx -u ${VARIABLE} "/k.json"\n`, VARIABLE)?.exported,
      ).toBe(false);
    });

    it("reads past a comment that follows the value", () => {
      expect(
        parseSetting(
          `export ${VARIABLE}="/k.json" # the reporting key\n`,
          VARIABLE,
        )?.value,
      ).toBe("/k.json");
    });

    it("returns undefined for a mention that sets nothing", () => {
      expect(parseSetting(`# ${VARIABLE} is the opt-in\n`, VARIABLE))
        .toBeUndefined();
      expect(parseSetting(`echo "$${VARIABLE}"\n`, VARIABLE)).toBeUndefined();
      expect(parseSetting("", VARIABLE)).toBeUndefined();
    });
  });

  describe("exportFromProfiles()", () => {
    function zsh(): Environment {
      return environment({ SHELL: "/bin/zsh", HOME: home });
    }

    it("reports a conflicting line in the profile read after it", async () => {
      const key = join(home, ".config", "k.json");
      await Deno.writeTextFile(
        join(home, ".zshrc"),
        `export ${VARIABLE}="/somewhere/else.json"\n`,
      );

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      // .zshrc is read after .zshenv, so what it says would win.
      expect(updates).toEqual([
        {
          path: join(home, ".zshrc"),
          outcome: "conflict",
          existing: `export ${VARIABLE}="/somewhere/else.json"`,
        },
        { path: join(home, ".zshenv"), outcome: "added" },
      ]);
    });

    it("appends the marked line to the profile", async () => {
      const key = join(home, ".config", "k.json");
      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates).toEqual([
        { path: join(home, ".zshenv"), outcome: "added" },
      ]);
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(
        `${MARKER}\nexport ${VARIABLE}="$HOME/.config/k.json"\n`,
      );
    });

    it("keeps an existing profile's contents and its trailing newline", async () => {
      await Deno.writeTextFile(join(home, ".zshenv"), "alias l=ls");
      const key = join(home, ".config", "k.json");

      await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(
        `alias l=ls\n\n${MARKER}\nexport ${VARIABLE}="$HOME/.config/k.json"\n`,
      );
    });

    it("reports the same value as already present and writes nothing", async () => {
      const key = join(home, ".config", "k.json");
      await exportFromProfiles(VARIABLE, key, zsh(), "darwin");
      const before = await Deno.readTextFile(join(home, ".zshenv"));

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates).toEqual([
        { path: join(home, ".zshenv"), outcome: "present" },
      ]);
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(before);
    });

    it("reports a value that only starts the same as a conflict", async () => {
      const key = join(home, ".config", "k.json");
      await Deno.writeTextFile(
        join(home, ".zshenv"),
        `export ${VARIABLE}="${key}.backup"\n`,
      );

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates[0]?.outcome).toBe("conflict");
    });

    it("accepts an export that carries a comment after it", async () => {
      const key = join(home, ".config", "k.json");
      await Deno.writeTextFile(
        join(home, ".zshenv"),
        `export ${VARIABLE}="$HOME/.config/k.json" # the reporting key\n`,
      );

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates[0]?.outcome).toBe("present");
    });

    it("reports a single-quoted $HOME as the other value it is", async () => {
      const key = join(home, ".config", "k.json");
      await Deno.writeTextFile(
        join(home, ".zshenv"),
        `export ${VARIABLE}='$HOME/.config/k.json'\n`,
      );

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      // Single quotes expand nothing, so that line names a file called
      // "$HOME/.config/k.json" and not the one being installed.
      expect(updates[0]?.outcome).toBe("conflict");
    });

    it("reports an assignment that is never exported", async () => {
      const key = join(home, ".config", "k.json");
      await Deno.writeTextFile(
        join(home, ".zshenv"),
        `${VARIABLE}="$HOME/.config/k.json"\n`,
      );

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates).toEqual([{
        path: join(home, ".zshenv"),
        outcome: "unexported",
        existing: `${VARIABLE}="$HOME/.config/k.json"`,
      }]);
    });

    it("reports a missing login profile rather than creating one", async () => {
      await Deno.writeTextFile(join(home, ".bashrc"), "");
      const env = environment({ SHELL: "/bin/bash", HOME: home });

      const updates = await exportFromProfiles(
        VARIABLE,
        join(home, "k.json"),
        env,
        "darwin",
      );

      expect(updates).toEqual([
        { path: join(home, ".bash_profile"), outcome: "absent" },
        { path: join(home, ".bashrc"), outcome: "added" },
      ]);
      // Creating it is what stops a login shell reading .profile.
      await expect(Deno.stat(join(home, ".bash_profile"))).rejects.toThrow();
    });

    it("reports a line pointing elsewhere as a conflict", async () => {
      await Deno.writeTextFile(
        join(home, ".zshenv"),
        `export ${VARIABLE}="/somewhere/else.json"\n`,
      );
      const key = join(home, ".config", "k.json");

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates).toEqual([{
        path: join(home, ".zshenv"),
        outcome: "conflict",
        existing: `export ${VARIABLE}="/somewhere/else.json"`,
      }]);
    });

    it("updates every bash profile that exists", async () => {
      await Deno.writeTextFile(join(home, ".bashrc"), "");
      await Deno.writeTextFile(join(home, ".bash_profile"), "");
      const env = environment({ SHELL: "/bin/bash", HOME: home });

      const updates = await exportFromProfiles(
        VARIABLE,
        join(home, "k.json"),
        env,
        "darwin",
      );

      expect(updates.map((update) => update.path)).toEqual([
        join(home, ".bash_profile"),
        join(home, ".bashrc"),
      ]);
      for (const update of updates) expect(update.outcome).toBe("added");
    });

    it("creates the first profile when the shell has none", async () => {
      const env = environment({ SHELL: "/bin/fish", HOME: home });

      const updates = await exportFromProfiles(
        VARIABLE,
        join(home, "k.json"),
        env,
        "linux",
      );

      const path = join(home, ".config", "fish", "config.fish");
      expect(updates).toEqual([{ path, outcome: "added" }]);
      expect(await Deno.readTextFile(path)).toBe(
        `${MARKER}\nset -gx ${VARIABLE} "$HOME/k.json"\n`,
      );
    });

    it("raises a profile that cannot be read", async () => {
      await Deno.mkdir(join(home, ".zshenv"));

      await expect(
        exportFromProfiles(VARIABLE, join(home, "k.json"), zsh(), "darwin"),
      ).rejects.toThrow();
    });

    it("returns nothing when there is no home directory to write in", async () => {
      expect(
        await exportFromProfiles(VARIABLE, "/k.json", environment({})),
      ).toEqual([]);
    });
  });

  describe("stripMarkedBlock()", () => {
    const WRITTEN = `export ${VARIABLE}="/k.json"`;

    it("takes out the marker, its line, and the blank line before it", () => {
      const text = `alias l=ls\n\n${MARKER}\n${WRITTEN}\n`;
      expect(stripMarkedBlock(text, WRITTEN)).toEqual({
        text: "alias l=ls\n",
        removed: true,
      });
    });

    it("leaves a marker that introduces something else", () => {
      const text = `${MARKER}\necho hello\n`;
      expect(stripMarkedBlock(text, WRITTEN)).toEqual({
        text,
        removed: false,
      });
    });

    it("leaves a marked line a person has since edited", () => {
      const text = `${MARKER}\nexport ${VARIABLE}="/somewhere/else.json"\n`;
      expect(stripMarkedBlock(text, WRITTEN)).toEqual({
        text,
        removed: false,
      });
    });

    it("leaves a line the tool did not write", () => {
      const text = `${WRITTEN}\n`;
      expect(stripMarkedBlock(text, WRITTEN)).toEqual({
        text,
        removed: false,
      });
    });
  });

  describe("unexportFromProfiles()", () => {
    function zshEnv(): Environment {
      return environment({ SHELL: "/bin/zsh", HOME: home });
    }

    it("removes what it wrote and leaves the rest of the file", async () => {
      await Deno.writeTextFile(join(home, ".zshrc"), "alias l=ls\n");
      await exportFromProfiles(VARIABLE, KEY_PATH, zshEnv(), "darwin");

      const removals = await unexportFromProfiles(
        VARIABLE,
        KEY_PATH,
        zshEnv(),
        "darwin",
      );

      expect(removals).toEqual([
        { path: join(home, ".zshenv"), outcome: "removed" },
      ]);
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe("");
      expect(await Deno.readTextFile(join(home, ".zshrc"))).toBe(
        "alias l=ls\n",
      );
    });

    it("keeps a line the tool did not write", async () => {
      await Deno.writeTextFile(
        join(home, ".zshenv"),
        `export ${VARIABLE}="/elsewhere.json"\n`,
      );

      const removals = await unexportFromProfiles(
        VARIABLE,
        KEY_PATH,
        zshEnv(),
        "darwin",
      );

      expect(removals).toEqual([{
        path: join(home, ".zshenv"),
        outcome: "kept",
        existing: `export ${VARIABLE}="/elsewhere.json"`,
      }]);
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(
        `export ${VARIABLE}="/elsewhere.json"\n`,
      );
    });

    it("returns nothing when no profile mentions it", async () => {
      await Deno.writeTextFile(join(home, ".zshenv"), "alias l=ls\n");
      expect(await unexportFromProfiles(VARIABLE, KEY_PATH, zshEnv(), "darwin"))
        .toEqual([]);
    });

    it("removes from a profile it only reads as well", async () => {
      await Deno.writeTextFile(
        join(home, ".zshrc"),
        `${MARKER}\nexport ${VARIABLE}="$HOME/k.json"\n`,
      );

      const removals = await unexportFromProfiles(
        VARIABLE,
        KEY_PATH,
        zshEnv(),
        "darwin",
      );

      expect(removals).toEqual([
        { path: join(home, ".zshrc"), outcome: "removed" },
      ]);
    });
  });

  describe("reexportFromProfiles()", () => {
    function zshEnv(): Environment {
      return environment({ SHELL: "/bin/zsh", HOME: home });
    }

    it("points what it wrote at the new value, in place", async () => {
      await Deno.writeTextFile(join(home, ".zshrc"), "alias l=ls\n");
      await exportFromProfiles(VARIABLE, KEY_PATH, zshEnv(), "darwin");
      await Deno.writeTextFile(join(home, ".zshenv"), "# end\n", {
        append: true,
      });
      const moved = join(home, "moved.json");

      expect(
        await reexportFromProfiles(
          VARIABLE,
          KEY_PATH,
          moved,
          zshEnv(),
          "darwin",
        ),
      ).toEqual([join(home, ".zshenv")]);
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(
        `${MARKER}\n${exportLine("zsh", VARIABLE, moved, home)}\n# end\n`,
      );
      // Done once, there is nothing left to do.
      expect(
        await reexportFromProfiles(
          VARIABLE,
          KEY_PATH,
          moved,
          zshEnv(),
          "darwin",
        ),
      ).toEqual([]);
    });

    it("leaves a line it did not write, whatever it names", async () => {
      const line = exportLine("zsh", VARIABLE, KEY_PATH, home);
      const other = `${MARKER}\n${
        exportLine("zsh", VARIABLE, join(home, "other.json"), home)
      }\n`;
      await Deno.writeTextFile(join(home, ".zshenv"), `${line}\n${other}`);

      expect(
        await reexportFromProfiles(
          VARIABLE,
          KEY_PATH,
          join(home, "moved.json"),
          zshEnv(),
          "darwin",
        ),
      ).toEqual([]);
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(
        `${line}\n${other}`,
      );
    });
  });

  describe("reloadHint()", () => {
    it("returns the command that loads the profile", () => {
      expect(reloadHint("/h/.zshrc", "zsh")).toBe(". /h/.zshrc");
      expect(reloadHint("/h/config.fish", "fish")).toBe(
        "source /h/config.fish",
      );
    });
  });
});

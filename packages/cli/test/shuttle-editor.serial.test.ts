/**
 * Unit tests for the round trip through a person's editor.
 *
 * Every effect the trip has on the world arrives through a parameter — the
 * environment, the file, the process — so each case drives the whole of it
 * with no editor, no file and no process behind it. What the cases are about
 * is the part a real editor could not be asked to demonstrate: which arms
 * leave the file where it is, and which one hands the caller the way to remove
 * it.
 *
 * The file's fate is the property the file exists for. What a person typed
 * into an editor is theirs, so the trip removes nothing itself: an editor that
 * failed and a read that failed each name the file, and a trip that came back
 * with text hands over a `discard` for the caller to call once the text was
 * any use.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

/**
 * The variable the trip reads its editor's name from, named here as the module
 * names it so a case sets the one the code reads.
 */
const EDITOR = "EDITOR";

import { type EditorDeps, openEditor } from "../lib/shuttle/editor.ts";

/** The file every case's `makeTempFile` hands back. */
const FILE = "/tmp/shuttle-abc.json";

/** What a case saw of the world the trip reached. */
interface Reached {
  /** The variables the trip read. */
  readonly asked: string[];

  /** What was written to the file, in the order it was written. */
  readonly written: string[];

  /** The command and arguments each run was given. */
  readonly ran: string[][];

  /** The files removed, in the order they were removed. */
  readonly removed: string[];
}

/**
 * Helper for the cases below, which is a world where `$EDITOR` is `editor`,
 * the editor ends with `code`, and the file reads back as `saved`.
 */
function world(
  options: {
    /** What `$EDITOR` holds. Absent means `vi`; an explicit `undefined`
     * means the variable is not set, which is a case of its own. */
    editor?: string | undefined;
    code?: number;
    saved?: string;
    run?: EditorDeps["run"];
    readTextFile?: EditorDeps["readTextFile"];
  } = {},
): { deps: EditorDeps; reached: Reached } {
  const editor = "editor" in options ? options.editor : "vi";
  const { code = 0, saved = "2", ...rest } = options;
  const reached: Reached = { asked: [], written: [], ran: [], removed: [] };
  return {
    deps: {
      env: (name) => {
        reached.asked.push(name);
        return editor;
      },
      makeTempFile: () => Promise.resolve(FILE),
      writeTextFile: (_path, text) => {
        reached.written.push(text);
        return Promise.resolve();
      },
      readTextFile: rest.readTextFile ?? (() => Promise.resolve(saved)),
      removeFile: (path) => {
        reached.removed.push(path);
        return Promise.resolve();
      },
      run: rest.run ?? ((command, args) => {
        reached.ran.push([command, ...args]);
        return Promise.resolve({ code });
      }),
    },
    reached,
  };
}

/** Helper for the cases below, which is the reason a trip was refused. */
function reasonOf(editing: { kind: string; reason?: string }): string {
  return editing.kind === "refused" ? editing.reason ?? "" : "not refused";
}

describe("openEditor()", () => {
  it("returns the text the editor saved", async () => {
    const { deps } = world({ saved: '{"title":"b"}' });
    const editing = await openEditor("1", deps);
    expect(editing.kind === "edited" && editing.text).toBe('{"title":"b"}');
  });

  it("writes the text it was given to the file the editor opens", async () => {
    const { deps, reached } = world();
    await openEditor('{\n  "a": 1\n}', deps);
    expect(reached.written).toEqual(['{\n  "a": 1\n}']);
  });

  it("runs the editor over the file, and nothing else", async () => {
    const { deps, reached } = world();
    await openEditor("1", deps);
    expect(reached.ran).toEqual([["vi", FILE]]);
  });

  it("runs the words `$EDITOR` holds as the editor and its own arguments", async () => {
    // The variable is a command line in practice — `code --wait` and
    // `emacsclient -nw` are editors — so the words after the program are the
    // editor's, and the file goes last.
    const { deps, reached } = world({ editor: "  code   --wait  " });
    await openEditor("1", deps);
    expect(reached.ran).toEqual([["code", "--wait", FILE]]);
  });

  it("reads `$EDITOR` and nothing else off the environment", async () => {
    const { deps, reached } = world();
    await openEditor("1", deps);
    expect(reached.asked).toEqual(["EDITOR"]);
  });

  it("returns a refusal naming the variable where it holds no editor", async () => {
    for (const editor of [undefined, "", "   "]) {
      const { deps, reached } = world({ editor });
      expect(reasonOf(await openEditor("1", deps))).toBe(
        "`$EDITOR` names no editor, so there is nothing to open the value " +
          "in. Set it to the editor to run, as in `EDITOR=vi`.",
      );
      expect(reached.written).toEqual([]);
    }
  });

  it("returns a refusal naming the status and the file where the editor ended nonzero", async () => {
    // An editor that ended nonzero is taken at its word: nothing is read back,
    // so a person who quit without saving does not have their old value
    // written over a new one.
    const { deps } = world({ code: 1 });
    expect(reasonOf(await openEditor("1", deps))).toBe(
      `\`vi\` ended with status 1, so nothing was written back. The value is ` +
        `in \`${FILE}\`.`,
    );
  });

  it("returns a refusal naming the file where the editor would not run", async () => {
    const { deps } = world({
      run: () => Promise.reject(new Error("No such file or directory.")),
    });
    expect(reasonOf(await openEditor("1", deps))).toBe(
      `\`vi\` did not run, and the value is in \`${FILE}\`: No such file ` +
        `or directory.`,
    );
  });

  it("returns a refusal naming the file where the text could not be read back", async () => {
    const { deps } = world({
      readTextFile: () => Promise.reject(new Error("Permission denied.")),
    });
    expect(reasonOf(await openEditor("1", deps))).toBe(
      `The edited value could not be read back, and it is in \`${FILE}\`: ` +
        `Permission denied.`,
    );
  });

  describe("the file the editor opened", () => {
    // The one property the whole design is for: the trip removes nothing
    // itself, so no arm can lose what a person typed. Each case here is one
    // arm, and the caller's `discard` is the only thing that removes the file.

    it("stays where it is on every arm", async () => {
      const worlds = [
        world(),
        world({ code: 1 }),
        world({ run: () => Promise.reject(new Error("no")) }),
        world({ readTextFile: () => Promise.reject(new Error("no")) }),
      ];
      for (const one of worlds) {
        await openEditor("1", one.deps);
        expect(one.reached.removed).toEqual([]);
      }
    });

    it("is removed by the `discard` a trip that came back hands over", async () => {
      const { deps, reached } = world();
      const editing = await openEditor("1", deps);
      expect(editing.kind).toBe("edited");
      if (editing.kind !== "edited") return;
      expect(editing.file).toBe(FILE);
      await editing.discard();
      expect(reached.removed).toEqual([FILE]);
    });
  });

  describe("the world it reaches when a caller names none", () => {
    // Every case above stands in for the environment, the file and the
    // process, which is what lets them drive the trip with none of the three.
    // This one drives the defaults instead, because a seam nothing ever runs
    // is a seam whose wiring nobody has checked: the file the editor opens is
    // a real one, the editor is a real program, and what comes back is what
    // was on disk.
    //
    // The editor is `true`, which reads nothing, writes nothing and exits
    // zero. It is on the path of every platform this runs on, and running it
    // changes nothing outside the temporary file this case makes.

    it("writes the value to a real file, runs `$EDITOR` over it, and reads it back", async () => {
      const before = Deno.env.get(EDITOR);
      Deno.env.set(EDITOR, "true");
      try {
        const editing = await openEditor('{"a":1}');
        expect(editing.kind).toBe("edited");
        if (editing.kind !== "edited") return;
        // `true` leaves the file alone, so what comes back is what went out —
        // which is the round trip through the real writer and reader.
        expect(editing.text).toBe('{"a":1}');
        expect(await Deno.readTextFile(editing.file)).toBe('{"a":1}');
        await editing.discard();
        await expect(Deno.stat(editing.file)).rejects.toThrow();
      } finally {
        if (before === undefined) Deno.env.delete(EDITOR);
        else Deno.env.set(EDITOR, before);
      }
    });

    it("refuses where the real environment names no editor", async () => {
      const before = Deno.env.get(EDITOR);
      Deno.env.delete(EDITOR);
      try {
        const editing = await openEditor("{}");
        expect(editing.kind === "refused" ? editing.reason : "")
          .toContain("names no editor");
      } finally {
        if (before !== undefined) Deno.env.set(EDITOR, before);
      }
    });

    it("refuses where the named editor is not a program, naming the file", async () => {
      // The real `Deno.Command` failing to start, which is the arm the
      // stand-in cases reach by throwing.

      const before = Deno.env.get(EDITOR);
      Deno.env.set(EDITOR, "shuttle-no-such-editor-b2");
      try {
        const editing = await openEditor("{}");
        const reason = editing.kind === "refused" ? editing.reason : "";
        expect(reason).toContain("did not run, and the value is in");
        const file = reason.match(/`([^`]*\.json)`/)?.[1];
        expect(file).toBeDefined();
        if (file !== undefined) await Deno.remove(file);
      } finally {
        if (before === undefined) Deno.env.delete(EDITOR);
        else Deno.env.set(EDITOR, before);
      }
    });
  });
});

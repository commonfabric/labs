/**
 * The round trip through a person's editor: text out to a file, the editor
 * over it, and whatever they saved back.
 *
 * `edit` is the one write with no `cf` equivalent behind it, and this is the
 * whole of what makes it one. Every effect it has on the world arrives through
 * a parameter — the environment it reads the editor's name from, the file it
 * writes, the process it runs — so a case drives the round trip with no
 * editor, no file and no process behind it.
 *
 * The file is left behind wherever the trip did not finish, and the caller is
 * told where. What a person typed into an editor is theirs, and a temporary
 * file removed on the way out of a failure is the one outcome that loses it.
 */

import { messageOf } from "./place.ts";

/** The environment variable naming the editor to run. */
const EDITOR = "EDITOR";

/** What a run of the editor did. */
export type Editing =
  /** The editor ran, and `text` is what was saved. */
  | {
    /** Names this arm of {@link Editing}. */
    readonly kind: "edited";

    /** What the editor saved, as it saved it. */
    readonly text: string;

    /** Where that text still is, for a caller that cannot use it to name. */
    readonly file: string;

    /**
     * Removes the file. The caller calls it once it has taken what it needs
     * out of `text`, and leaves it uncalled where it could not — a value that
     * will not parse is work a person did, and the file is the only copy of
     * it.
     */
    discard(): Promise<void>;
  }
  /** The trip did not finish, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string };

/** The world {@link openEditor} reaches, so that a case can stand for it. */
export interface EditorDeps {
  /** Reads an environment variable; the process's environment by default. */
  readonly env?: (name: string) => string | undefined;

  /** Makes the file the editor opens, and returns its path. */
  readonly makeTempFile?: (options: { suffix: string }) => Promise<string>;

  /** Writes the file the editor opens. */
  readonly writeTextFile?: (path: string, text: string) => Promise<void>;

  /** Reads back what the editor saved. */
  readonly readTextFile?: (path: string) => Promise<string>;

  /** Removes the file once nothing needs it. */
  readonly removeFile?: (path: string) => Promise<void>;

  /**
   * Runs `command` with `args`, waits for it, and returns how it ended. It
   * inherits this process's terminal, which is what lets a full-screen editor
   * draw on it.
   */
  readonly run?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ readonly code: number }>;
}

/**
 * Opens the person's editor on `text` and returns what they saved, or the
 * reason the trip did not finish.
 *
 * The editor's name comes from `$EDITOR` and is run as a command line rather
 * than as a bare program name, because that is how the variable is written in
 * practice: `code --wait` and `emacsclient -nw` are editors, and the words
 * after the program are the editor's own. The line is split on whitespace,
 * which is the whole of the reading — a path holding a space has to be spelled
 * some other way, and saying so is better than a quoting rule nobody else
 * shares.
 *
 * An editor that ends with a nonzero status is taken at its word: nothing is
 * read back and the caller is told, so a person who quit without saving does
 * not have their old value written back over a new one.
 *
 * The file is never removed here. An editor that failed, and a read that
 * failed, each leave it where it is and name it; a trip that came back with
 * text hands the caller the way to remove it, because only the caller knows
 * whether the text was any use. What a person typed is theirs, and a temporary
 * file removed on the way out of a failure is the one outcome that loses it.
 */
export async function openEditor(
  text: string,
  deps: EditorDeps = {},
): Promise<Editing> {
  const named = (deps.env ?? readEnv)(EDITOR);
  const words = (named ?? "").trim().split(/\s+/).filter((word) => word !== "");
  const [program, ...args] = words;
  if (program === undefined) {
    return refuse(
      `\`$${EDITOR}\` names no editor, so there is nothing to open the value ` +
        `in. Set it to the editor to run, as in \`${EDITOR}=vi\`.`,
    );
  }
  const file = await (deps.makeTempFile ?? makeTempFile)({ suffix: ".json" });
  await (deps.writeTextFile ?? writeTextFile)(file, text);
  let ended;
  try {
    ended = await (deps.run ?? runCommand)(program, [...args, file]);
  } catch (thrown) {
    return refuse(
      `\`${program}\` did not run, and the value is in \`${file}\`: ` +
        `${messageOf(thrown)}`,
    );
  }
  if (ended.code !== 0) {
    return refuse(
      `\`${program}\` ended with status ${ended.code}, so nothing was ` +
        `written back. The value is in \`${file}\`.`,
    );
  }
  let saved;
  try {
    saved = await (deps.readTextFile ?? readTextFile)(file);
  } catch (thrown) {
    return refuse(
      `The edited value could not be read back, and it is in \`${file}\`: ` +
        `${messageOf(thrown)}`,
    );
  }
  return {
    kind: "edited",
    text: saved,
    file,
    discard: () => (deps.removeFile ?? removeFile)(file),
  };
}

/** Helper for {@link openEditor}, which reads `name` off the environment. */
function readEnv(name: string): string | undefined {
  return Deno.env.get(name);
}

/** Helper for {@link openEditor}, which makes the file the editor opens. */
function makeTempFile(options: { suffix: string }): Promise<string> {
  return Deno.makeTempFile({ prefix: "shuttle-", suffix: options.suffix });
}

/** Helper for {@link openEditor}, which writes the file the editor opens. */
function writeTextFile(path: string, text: string): Promise<void> {
  return Deno.writeTextFile(path, text);
}

/** Helper for {@link openEditor}, which reads back what the editor saved. */
function readTextFile(path: string): Promise<string> {
  return Deno.readTextFile(path);
}

/** Helper for {@link openEditor}, which removes the file. */
function removeFile(path: string): Promise<void> {
  return Deno.remove(path);
}

/**
 * Helper for {@link openEditor}, which runs the editor over this process's own
 * terminal and returns how it ended.
 *
 * Every stream is inherited, which is what a full-screen editor needs: it
 * reads the keyboard and draws on the screen itself, and a pipe on either
 * would leave it drawing into a buffer nobody shows.
 */
async function runCommand(
  command: string,
  args: readonly string[],
): Promise<{ code: number }> {
  const { code } = await new Deno.Command(command, {
    args: [...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return { code };
}

/** Helper for {@link openEditor}, which builds a refusal carrying `reason`. */
function refuse(reason: string): Editing {
  return { kind: "refused", reason };
}

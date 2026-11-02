/**
 * Runs `deno task topics browse`: the {@link Browser} on the whole terminal,
 * following the board live through `watch.ts`'s runner, with what it
 * remembers between runs kept in a file of the person's own, and the web
 * browser and the clipboard reached through the system's own programs.
 */

import { basename, dirname } from "@std/path";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import {
  Browser,
  type Draft,
  type Dropped,
  type Host,
  type Opening,
  type Pending,
  type Saved,
  type WriteRequest,
} from "./browser.ts";
import { type Plain, toPlain } from "./mirror.ts";
import { replaceFile } from "./sync.ts";
import {
  showBoard,
  topicLinks,
  type WatchBoard,
  type WatchDeps,
} from "./watch.ts";
import { mergeSaved } from "./writes.ts";

/** The board `browse` shows, and where what it remembers is kept. */
export interface BrowseBoard extends WatchBoard {
  /** Where what the browser remembers between runs is kept. */
  state: string;

  /** The DID of the person viewing, who reads and writes as it. */
  viewer?: string;
}

/** What `browse` needs from the world, beyond what `watch` needs. */
export interface BrowseDeps extends WatchDeps {
  write: Host["write"];
  open: Host["open"];
  copy: Host["copy"];
}

/**
 * Shows the board `board` names in the browser, live, until the person
 * quits, the terminal's input ends, or the process is signaled to end,
 * opening Topic `open` when one is named and signing writes as
 * `agentName` when one is given. Writes under way finish, and what the
 * browser remembers is saved, before it returns, however it ends.
 */
export async function browseBoard(
  board: BrowseBoard,
  deps: BrowseDeps,
  { open, agentName }: { open?: Opening; agentName?: string } = {},
): Promise<void> {
  const saved = await loadSaved(board.state, deps.clock.now());
  let browser: Browser | undefined;
  const keeper = new Keeper(
    board.state,
    () => deps.clock.now(),
    (error) => browser?.saveFailed(error),
  );
  // What another browser saves is taken in as it is saved.
  using _following = await followSaved(
    board.state,
    (theirs) => browser?.reconcile(theirs),
  );
  let failure: { error: unknown } | undefined;
  try {
    await showBoard(board, deps, ({ redraw }) => {
      browser = new Browser({
        board: {
          space: board.space,
          topicLinks: topicLinks(board),
          viewer: board.viewer,
        },
        host: {
          write: deps.write,
          open: deps.open,
          copy: deps.copy,
          save: (state) => keeper.save(state),
          persisted: () => keeper.settled(),
        },
        saved,
        redraw,
        now: () => deps.clock.now(),
        open,
        agentName,
      });
      return browser;
    });
  } catch (error) {
    failure = { error };
  }
  try {
    await keeper.settled();
  } catch (error) {
    // Neither failure hides the other.
    if (failure === undefined) throw error;
    throw new AggregateError(
      [failure.error, error],
      `${describeFailure(failure.error)}\n${describeFailure(error)}`,
    );
  }
  if (failure !== undefined) throw failure.error;
}

/**
 * Calls `changed` with what is saved at `path` whenever the file changes,
 * until disposed. A version this build cannot read is passed over, as the
 * next save says.
 */
export async function followSaved(
  path: string,
  changed: (saved: Saved) => void,
): Promise<Disposable> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const watcher = Deno.watchFs(dirname(path), { recursive: false });
  const name = basename(path);
  (async () => {
    for await (const event of watcher) {
      if (!event.paths.some((changed) => basename(changed) === name)) continue;
      const theirs = await readSaved(path).catch(() => undefined);
      if (theirs !== undefined) changed(theirs.saved);
    }
  })();
  return { [Symbol.dispose]: () => watcher.close() };
}

/**
 * What the browser remembers, read from `path`, or a fresh start at `now`
 * when there is nothing there to read; a file that holds something else is
 * an error, since writing over it would lose it.
 */
export async function loadSaved(path: string, now: number): Promise<Saved> {
  return (await readSaved(path))?.saved ?? {
    since: now,
    seen: {},
    drafts: {},
    pending: {},
    dropped: {},
    hideSettled: true,
  };
}

/**
 * What is saved at `path`, or `undefined` when nothing is: what this build
 * reads of it, and the file whole, so that what a newer build added, which
 * this one does not read, is written back as it was.
 */
async function readSaved(
  path: string,
): Promise<{ saved: Saved; whole: Record<string, Plain> } | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  let whole: Plain | undefined;
  try {
    whole = toPlain(JSON.parse(text));
  } catch {
    whole = undefined;
  }
  const saved = isObjectNotArray(whole) ? readable(whole) : undefined;
  if (saved === undefined || !isObjectNotArray(whole)) {
    throw new Error(
      `\`${path}\` does not hold what the Topics browser remembers; move it ` +
        "aside to start afresh.",
    );
  }
  return { saved, whole };
}

/**
 * What this build reads of `value`, the saved file whole: a draft, pending
 * write, or tombstone this build cannot read, of a shape a newer build
 * added, left out.
 */
function readable(value: Record<string, Plain>): Saved | undefined {
  const { since, seen, drafts, pending, dropped, agentName, hideSettled } =
    value;
  if (
    !(typeof since === "number" && isNumbers(seen) &&
      isObjectNotArray(drafts) && isObjectNotArray(pending) &&
      isObjectNotArray(dropped) &&
      (agentName === undefined || typeof agentName === "string") &&
      typeof hideSettled === "boolean")
  ) {
    return undefined;
  }
  const keptDrafts: Record<string, Draft> = {};
  for (const [key, draft] of Object.entries(drafts)) {
    if (isDraft(draft)) keptDrafts[key] = draft;
  }
  const keptDropped: Record<string, Dropped> = {};
  for (const [key, entry] of Object.entries(dropped)) {
    if (isDropped(entry)) keptDropped[key] = entry;
  }
  const kept: Record<string, Pending> = {};
  for (const [invocation, entry] of Object.entries(pending)) {
    if (isPending(entry)) kept[invocation] = entry;
  }
  return {
    since,
    seen,
    drafts: keptDrafts,
    pending: kept,
    dropped: keptDropped,
    ...(agentName === undefined ? {} : { agentName }),
    hideSettled,
  };
}

function isNumbers(value: unknown): value is Record<string, number> {
  return isObjectNotArray(value) &&
    Object.values(value).every((at) => typeof at === "number");
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((field) => typeof field === "string");
}

function isDraft(value: unknown): value is Draft {
  return isObjectNotArray(value) && isStrings(value.fields) &&
    typeof value.base === "string" && typeof value.at === "number";
}

function isDropped(value: unknown): value is Dropped {
  return isObjectNotArray(value) && typeof value.at === "number" &&
    typeof value.when === "number";
}

function isPending(value: unknown): value is Pending {
  if (!isObjectNotArray(value)) return false;
  const { request, agentName, attempts, draft, failure, at } = value;
  return isWriteRequest(request) && typeof agentName === "string" &&
    typeof attempts === "number" && typeof at === "number" &&
    (failure === undefined || typeof failure === "string") &&
    (draft === undefined ||
      (isObjectNotArray(draft) && typeof draft.key === "string" &&
        isStrings(draft.fields) && typeof draft.base === "string"));
}

function isWriteRequest(value: unknown): value is WriteRequest {
  if (!isObjectNotArray(value)) return false;
  const text = (...keys: string[]) =>
    keys.every((key) => typeof value[key] === "string");
  switch (value.verb) {
    case "new":
      return text("title", "body");
    case "comment":
    case "body":
    case "title":
      return text("topic", "text");
    case "link":
      return text("topic", "url", "label", "kind");
    case "unlink":
      return text("topic", "url");
    case "mention":
    case "unmention":
      return text("topic", "other");
    default:
      return false;
  }
}

/** How long a draft or write thrown away is remembered as thrown away. */
const FORGET_DROPPED_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Writes what the browser remembers to a file, one write at a time, the
 * latest state winning: a save asked for while one is under way is made
 * once that one finishes, with whatever is latest by then. Each write
 * merges what another browser saved there since, and renames a finished
 * file into place, so the file is always whole.
 */
export class Keeper {
  readonly #path: string;
  readonly #now: () => number;
  readonly #failed: (error: unknown) => void;
  #latest: Saved | undefined;
  #writing: Promise<void> | undefined;
  #failure: unknown;

  /**
   * A keeper of the file at `path`, reading the time from `now`, telling
   * `failed` of a write that fails.
   */
  constructor(
    path: string,
    now: () => number,
    failed: (error: unknown) => void = () => {},
  ) {
    this.#path = path;
    this.#now = now;
    this.#failed = failed;
  }

  /** Saves `state`, now or once the write under way finishes. */
  save(state: Saved): void {
    this.#latest = structuredClone(state);
    this.#writing ??= this.#drain();
  }

  /** Waits for every save asked for, failing when one did. */
  async settled(): Promise<void> {
    await this.#writing;
    if (this.#failure !== undefined) throw this.#failure;
  }

  async #drain(): Promise<void> {
    while (this.#latest !== undefined) {
      const ours = this.#latest;
      this.#latest = undefined;
      try {
        await this.#write(ours);
        this.#failure = undefined;
      } catch (error) {
        this.#failure = error;
        this.#failed(error);
      }
    }
    this.#writing = undefined;
  }

  /**
   * Writes `ours`, merged with what is saved there, while holding the
   * file's lock, so that two browsers saving at once lose neither's work.
   */
  async #write(ours: Saved): Promise<void> {
    await Deno.mkdir(dirname(this.#path), { recursive: true });
    using lock = await Deno.open(`${this.#path}.lock`, {
      create: true,
      write: true,
      mode: 0o600,
    });
    await lock.lock(true);
    const theirs = await readSaved(this.#path);
    const state = theirs === undefined ? ours : mergeSaved(theirs.saved, ours);
    // What was thrown away long ago no longer needs remembering: any
    // browser holding it has saved since.
    for (const [key, { when }] of Object.entries(state.dropped)) {
      if (when < this.#now() - FORGET_DROPPED_MS) delete state.dropped[key];
    }
    // What a newer build saved, and this one does not read, stays.
    const whole = theirs?.whole ?? {};
    const foreign = (field: "drafts" | "pending" | "dropped") => {
      const held = whole[field];
      const read = theirs?.saved[field] ?? {};
      return isObjectNotArray(held)
        ? Object.fromEntries(
          Object.entries(held).filter(([key]) => !(key in read)),
        )
        : {};
    };
    await replaceFile(
      this.#path,
      JSON.stringify({
        ...whole,
        ...state,
        drafts: { ...foreign("drafts"), ...state.drafts },
        pending: { ...foreign("pending"), ...state.pending },
        dropped: { ...foreign("dropped"), ...state.dropped },
      }),
    );
  }
}

/**
 * The program that opens an address in a web browser, and the one that
 * puts text on the clipboard, on the operating system `os`.
 */
export function systemPrograms(os: typeof Deno.build.os): {
  open: string[];
  copy: string[];
} {
  return os === "darwin"
    ? { open: ["open"], copy: ["pbcopy"] }
    : os === "windows"
    ? { open: ["explorer"], copy: ["clip"] }
    : { open: ["xdg-open"], copy: ["xclip", "-selection", "clipboard"] };
}

/**
 * Runs `argv` with `input` on its standard input and its output thrown
 * away, so that nothing it says reaches the terminal the browser draws on.
 * A program that is missing, or fails, is reported as such.
 */
export async function runQuietly(
  argv: readonly string[],
  input = "",
): Promise<void> {
  const [program, ...args] = argv;
  const child = new Deno.Command(program, {
    args,
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code } = await child.status;
  if (code !== 0) throw new Error(`\`${program}\` exited with status ${code}.`);
}

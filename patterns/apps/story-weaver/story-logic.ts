/**
 * Story Weaver's board logic, apart from the pattern that stores and shows it:
 * which spindles are on the board, the prompt each one sends, and how pinning,
 * respinning, branch changes and level changes rewrite the stored record.
 *
 * The board is a tree addressed by paths. The synopsis is the root. A spindle
 * at level `k` has a path of `k + 1` sibling indices joined by ".", so "0.2" is
 * the third child of the first spindle at level 0. A spindle exists on the
 * board when its parent is pinned (or, at level 0, when the synopsis is set)
 * and its sibling index is below its level's branch factor. Only what a person
 * did to a spindle is stored, so raising a branch factor or pinning a parent
 * needs no bookkeeping, and nothing holds an index that a deletion can shift.
 */

/** One generated layer of the story: chapters, scenes, beats... */
export interface Level {
  title: string;
  /** The instruction every spindle at this level sends after its parent. */
  prompt: string;
  /** How many sibling spindles each pinned parent gets at this level. */
  branch: number;
}

/** What a person did to one spindle. A spindle with no record is untouched. */
export interface Spindle {
  path: string;
  /** The pinned option's index, or -1. */
  pinned: number;
  /** The pinned option's text: the input of this spindle's children. */
  pinnedText: string;
  /** `textHash` of the parent's text when this spindle was pinned. */
  parentHash: string;
  /** Extra instruction for this spindle only. */
  extraPrompt: string;
  /** Bumped by Respin; part of the prompt, so it asks for fresh options. */
  respins: number;
  /** Generation was asked for. Spindles below level 0 wait for it. */
  requested: boolean;
}

/** A spindle on the board, with everything its card shows. */
export interface SpindleView {
  path: string;
  level: number;
  sibling: number;
  siblingCount: number;
  label: string;
  /** The start of the parent's text, to tell siblings of different parents
   * apart; "" at level 0. */
  parentSnippet: string;
  pinned: number;
  pinnedText: string;
  extraPrompt: string;
  stale: boolean;
  /** Stale only because a pin above it is: its own parent did not change, so
   * respinning it cannot help until the stale pin above is respun. */
  staleAbove: boolean;
  /** Generation runs on its own or was asked for. */
  ready: boolean;
  /** The full prompt, shown to the person. */
  prompt: string;
  /** The prompt to send now: `prompt` when ready, else "" (no request). */
  activePrompt: string;
  /** The summary request for the pinned text, or "". */
  summaryPrompt: string;
}

export interface LevelView {
  index: number;
  title: string;
  prompt: string;
  branch: number;
  isLast: boolean;
  spindles: SpindleView[];
}

export interface GenerationResult {
  options: Array<{ content: string }>;
}

export interface SummaryResult {
  summary: string;
}

export interface SynopsisIdeasResult {
  ideas: Array<{ title: string; synopsis: string }>;
}

export const NUM_OPTIONS = 4;
export const MAX_BRANCH = 6;

// The length cap keeps four options inside one response: asked for chapter
// summaries with no limit, the model wrote past its output budget and the
// cut-off JSON could not be parsed.
export const OPTIONS_SYSTEM =
  "You are a creative writing assistant. Generate 4 distinct options as requested. Each option should take a meaningfully different creative approach. Write each option in Markdown, and keep each one under 400 words. Don't title or number the options: the reader already sees them as Option 1 to 4.";

export const SUMMARY_SYSTEM = "You are a concise summarizer.";

export const IDEAS_SYSTEM =
  "You are a creative writing assistant specializing in story development. Generate compelling, original story premises.";

/** Suggested title and prompt for the next level, by how many there are. */
const LEVEL_SUGGESTIONS: Array<{ title: string; prompt: string }> = [
  {
    title: "Story Outline",
    prompt: "Create a detailed story outline based on the synopsis.",
  },
  {
    title: "Chapters",
    prompt: "Write chapter summaries based on the outline above.",
  },
  { title: "Scenes", prompt: "Break this chapter into detailed scenes." },
  {
    title: "Beats",
    prompt: "Expand this scene into specific beats and moments.",
  },
  { title: "Details", prompt: "Add rich details and descriptions." },
];

export const suggestedLevel = (
  levelCount: number,
): { title: string; prompt: string } =>
  LEVEL_SUGGESTIONS[levelCount] ?? {
    title: `Level ${levelCount + 1}`,
    prompt: "Continue developing the story.",
  };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const segments = (path: string): number[] => path.split(".").map(Number);

export const levelOf = (path: string): number => segments(path).length - 1;

export const siblingOf = (path: string): number => {
  const parts = segments(path);
  return parts[parts.length - 1];
};

/** The parent's path, or "" for a level-0 spindle (whose parent is the
 * synopsis). */
export const parentOf = (path: string): string =>
  path.split(".").slice(0, -1).join(".");

const childPath = (parent: string, sibling: number): string =>
  parent === "" ? `${sibling}` : `${parent}.${sibling}`;

/** A stable short hash, for noticing that a parent's text changed. */
export const textHash = (text: string): string => {
  if (!text) return "";
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
};

const byPath = (spindles: readonly Spindle[]): Map<string, Spindle> =>
  new Map(spindles.map((s) => [s.path, s]));

const blank = (path: string): Spindle => ({
  path,
  pinned: -1,
  pinnedText: "",
  parentHash: "",
  extraPrompt: "",
  respins: 0,
  requested: false,
});

const isPinned = (s: Spindle | undefined): s is Spindle =>
  !!s && s.pinned >= 0 && s.pinnedText !== "";

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** The paths on the board, level by level, in reading order. */
export const boardPaths = (
  levels: readonly Level[],
  synopsis: string,
  spindles: readonly Spindle[],
): string[][] => {
  const index = byPath(spindles);
  const result: string[][] = [];
  let parents: string[] = synopsis.trim() ? [""] : [];
  for (const level of levels) {
    const branch = Math.max(1, level.branch);
    const paths = parents.flatMap((parent) =>
      Array.from({ length: branch }, (_, i) => childPath(parent, i))
    );
    result.push(paths);
    parents = paths.filter((p) => isPinned(index.get(p)));
  }
  return result;
};

/** The text a spindle builds on: its parent's pinned text, or the synopsis. */
export const parentText = (
  path: string,
  synopsis: string,
  spindles: readonly Spindle[],
): string => {
  const parent = parentOf(path);
  if (parent === "") return synopsis;
  const record = byPath(spindles).get(parent);
  return isPinned(record) ? record.pinnedText : "";
};

/** The prompt a spindle sends for its options. */
export const buildPrompt = (
  input: string,
  level: Level,
  spindle: Pick<Spindle, "extraPrompt" | "respins">,
  sibling: number,
): string =>
  [
    input,
    level.prompt,
    spindle.extraPrompt,
    level.branch > 1
      ? `This is part ${
        sibling + 1
      } of ${level.branch} of "${level.title}". Write only that part.`
      : "",
    `Generate exactly ${NUM_OPTIONS} distinct options for the above.`,
    spindle.respins > 0 ? `[Generation attempt: ${spindle.respins}]` : "",
  ].filter((part) => part.trim() !== "").join("\n\n");

/** Whether a model call's state (its `messages`, the first of which is the
 * request) answers `prompt`. A card's request is tied to its list position,
 * not its spindle, so when the board shifts a card holds another spindle's
 * result until its own request catches up; this tells the two apart. */
export const answers = (
  messages: readonly { content?: unknown }[] | undefined,
  prompt: string,
): boolean => prompt !== "" && messages?.[0]?.content === prompt;

export const summaryPrompt = (pinnedText: string): string =>
  pinnedText
    ? `${pinnedText}\n\n---\n\nSummarize the above in 2-3 concise sentences.`
    : "";

export const ideasPrompt = (attempt: number): string =>
  attempt > 0
    ? `Generate 4 creative story synopsis ideas. Each should be a compelling premise for a novel or screenplay.

Make them diverse in genre and tone:
- One could be literary/dramatic
- One could be thriller/mystery
- One could be fantasy/sci-fi
- One could be contemporary/realistic

[Generation attempt: ${attempt}]`
    : "";

const snippet = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
};

/** Everything the board shows, level by level. */
export const boardView = (
  levels: readonly Level[],
  synopsis: string,
  spindles: readonly Spindle[],
): LevelView[] => {
  const index = byPath(spindles);
  const paths = boardPaths(levels, synopsis, spindles);
  // Levels are built in order, so a parent's staleness is known before its
  // children's: a pin built on a stale pin is stale too.
  const stale = new Set<string>();
  return levels.map((level, levelIndex) => ({
    index: levelIndex,
    title: level.title,
    prompt: level.prompt,
    branch: level.branch,
    isLast: levelIndex === levels.length - 1,
    spindles: (paths[levelIndex] ?? []).map((path): SpindleView => {
      const record = index.get(path) ?? blank(path);
      const input = parentText(path, synopsis, spindles);
      const sibling = siblingOf(path);
      const prompt = buildPrompt(input, level, record, sibling);
      const ready = input.trim() !== "" &&
        (levelIndex === 0 || record.requested);
      const pinned = isPinned(record);
      const ownStale = pinned && record.parentHash !== textHash(input);
      const staleAbove = pinned && !ownStale && stale.has(parentOf(path));
      const isStale = ownStale || staleAbove;
      if (isStale) stale.add(path);
      return {
        path,
        level: levelIndex,
        sibling,
        siblingCount: level.branch,
        label: level.branch > 1
          ? `${level.title} · ${sibling + 1} of ${level.branch}`
          : level.title,
        parentSnippet: levelIndex === 0 ? "" : snippet(input),
        pinned: pinned ? record.pinned : -1,
        pinnedText: pinned ? record.pinnedText : "",
        extraPrompt: record.extraPrompt,
        stale: isStale,
        staleAbove,
        ready,
        prompt,
        activePrompt: ready ? prompt : "",
        summaryPrompt: pinned ? summaryPrompt(record.pinnedText) : "",
      };
    }),
  }));
};

// ---------------------------------------------------------------------------
// Edits. Each returns the new record and leaves its argument alone.
// ---------------------------------------------------------------------------

const upsert = (
  spindles: readonly Spindle[],
  path: string,
  change: (s: Spindle) => Spindle,
): Spindle[] => {
  const existing = byPath(spindles).get(path);
  const next = change(existing ?? blank(path));
  return existing
    ? spindles.map((s) => (s.path === path ? next : s))
    : [...spindles, next];
};

/** Pins option `option` (text `text`) on `path`; pinning the pinned option
 * again unpins it. `input` is the parent text the spindle was built on. */
export const withPinned = (
  spindles: readonly Spindle[],
  path: string,
  option: number,
  text: string,
  input: string,
): Spindle[] =>
  upsert(
    spindles,
    path,
    (s) =>
      s.pinned === option && s.pinnedText === text
        ? { ...s, pinned: -1, pinnedText: "", parentHash: "" }
        : {
          ...s,
          pinned: option,
          pinnedText: text,
          parentHash: textHash(input),
          requested: true,
        },
  );

/** Asks `path` for fresh options, dropping its pin. */
export const withRespin = (
  spindles: readonly Spindle[],
  path: string,
): Spindle[] =>
  upsert(spindles, path, (s) => ({
    ...s,
    respins: s.respins + 1,
    requested: true,
    pinned: -1,
    pinnedText: "",
    parentHash: "",
  }));

/** Starts generation for a spindle that waits for it. */
export const withRequested = (
  spindles: readonly Spindle[],
  path: string,
): Spindle[] => upsert(spindles, path, (s) => ({ ...s, requested: true }));

/** Sets the spindle's extra instruction. It asks for new options, so the old
 * pin no longer describes them and is dropped. */
export const withExtraPrompt = (
  spindles: readonly Spindle[],
  path: string,
  extraPrompt: string,
): Spindle[] =>
  upsert(spindles, path, (s) =>
    s.extraPrompt === extraPrompt ? s : {
      ...s,
      extraPrompt,
      pinned: -1,
      pinnedText: "",
      parentHash: "",
    });

/** Spindles at `level` whose sibling index is `branch` or more, with
 * everything under them. */
const cutByBranch = (
  spindles: readonly Spindle[],
  level: number,
  branch: number,
): Spindle[] =>
  spindles.filter((s) => {
    const parts = segments(s.path);
    return parts.length > level && parts[level] >= branch;
  });

/** Pinned spindles on the board that `doomed` would remove. Records hidden
 * under an unpinned parent are not counted: the person can't see them. */
const pinsOnBoard = (
  levels: readonly Level[],
  synopsis: string,
  spindles: readonly Spindle[],
  doomed: readonly Spindle[],
): number => {
  const shown = new Set(boardPaths(levels, synopsis, spindles).flat());
  return doomed.filter((s) => isPinned(s) && shown.has(s.path)).length;
};

/** Pinned spindles on the board a branch change would remove. */
export const pinsLostByBranch = (
  levels: readonly Level[],
  synopsis: string,
  spindles: readonly Spindle[],
  level: number,
  branch: number,
): number =>
  pinsOnBoard(
    levels,
    synopsis,
    spindles,
    cutByBranch(spindles, level, branch),
  );

/** Pinned spindles on the board that removing the last level would remove. */
export const pinsLostByRemovingLevel = (
  levels: readonly Level[],
  synopsis: string,
  spindles: readonly Spindle[],
): number =>
  pinsOnBoard(
    levels,
    synopsis,
    spindles,
    spindles.filter((s) => levelOf(s.path) >= levels.length - 1),
  );

/** A branch factor in 1..MAX_BRANCH; anything not a number (the `setBranch`
 * stream takes whatever a caller sends) counts as 1. */
export const clampBranch = (branch: number): number =>
  Number.isFinite(branch)
    ? Math.min(MAX_BRANCH, Math.max(1, Math.round(branch)))
    : 1;

/** Sets a level's branch factor. Lowering it removes the spindles past the
 * new count and everything under them. */
export const withBranch = (
  levels: readonly Level[],
  spindles: readonly Spindle[],
  level: number,
  branch: number,
): { levels: Level[]; spindles: Spindle[] } => {
  if (!levels[level]) return { levels: [...levels], spindles: [...spindles] };
  const next = clampBranch(branch);
  const cut = new Set(cutByBranch(spindles, level, next).map((s) => s.path));
  return {
    levels: levels.map((l, i) => (i === level ? { ...l, branch: next } : l)),
    spindles: spindles.filter((s) => !cut.has(s.path)),
  };
};

/** Removes the last level and its spindles. */
export const withLastLevelRemoved = (
  levels: readonly Level[],
  spindles: readonly Spindle[],
): { levels: Level[]; spindles: Spindle[] } => {
  const keep = levels.length - 1;
  return {
    levels: levels.slice(0, Math.max(0, keep)),
    spindles: spindles.filter((s) => levelOf(s.path) < keep),
  };
};

// ---------------------------------------------------------------------------
// The woven story, as Markdown
// ---------------------------------------------------------------------------

/** Pushes every Markdown heading in `text` down `by` levels (to at most
 * `######`), so a pinned option's own "# Title" nests under the section it
 * lands in instead of outranking the story's headings. Fenced code is left
 * alone. */
export const demoteHeadings = (text: string, by: number): string => {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return line;
    const match = /^(#{1,6})(\s.*)?$/.exec(line);
    if (!match) return line;
    const depth = Math.min(6, match[1].length + by);
    return `${"#".repeat(depth)}${match[2] ?? ""}`;
  }).join("\n");
};

/** The story so far: the synopsis and every pinned spindle, level by level. */
export const storyMarkdown = (
  title: string,
  levels: readonly Level[],
  synopsis: string,
  spindles: readonly Spindle[],
): string => {
  const view = boardView(levels, synopsis, spindles);
  const sections = view.map((level) => {
    const pinned = level.spindles.filter((s) => s.pinnedText !== "");
    if (pinned.length === 0) return "";
    const body = pinned.map((s) =>
      pinned.length > 1 || level.branch > 1
        ? `### ${s.label}${s.stale ? " (stale)" : ""}\n\n${
          demoteHeadings(s.pinnedText, 3)
        }`
        : `${s.stale ? "_(stale)_\n\n" : ""}${demoteHeadings(s.pinnedText, 2)}`
    );
    return [`## ${level.title}`, ...body].join("\n\n");
  });
  return [
    `# ${title}`,
    "## Synopsis",
    synopsis.trim() || "_(not started)_",
    ...sections.filter((s) => s !== ""),
  ].join("\n\n");
};

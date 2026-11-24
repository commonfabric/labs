/**
 * Story Weaver — grow a story with AI, one level at a time.
 *
 * Write (or ask for) a synopsis, then weave down through levels such as
 * Characters & Themes, Chapters and Scenes. Each spindle on the board asks the
 * model for four options built on its parent; pin the one you like and its
 * children appear on the next level, ready to build on it. A level's branch
 * factor sets how many sibling spindles each pinned parent gets (chapter 1 of
 * 3, 2 of 3...). Respin asks for fresh options, a spindle can carry its own
 * extra instruction, and a pin whose parent has since changed is flagged stale.
 *
 * Ported from jkomoros/community-patterns (`story-weaver.tsx`, formerly
 * spindle-board) and rebuilt: the board is now a tree addressed by paths, and
 * only what a person did to a spindle is stored, so the spindles on the board
 * are derived (see `story-logic.ts`). The synopsis is committed explicitly, so
 * editing it after the story starts reaches the levels below (and flags their
 * pins stale) instead of being silently ignored.
 */
import {
  action,
  computed,
  Default,
  FS,
  generateObject,
  hasError,
  isObsolete,
  isPending,
  isSyncing,
  NAME,
  pattern,
  type PerSpace,
  type ReadonlyCell,
  resultOf,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  boardView,
  type CardPin,
  clampBranch,
  type GenerationResult,
  IDEAS_SYSTEM,
  ideasPrompt,
  type Level,
  MAX_BRANCH,
  OPTIONS_SYSTEM,
  parentText,
  pinsLostByBranch,
  pinsLostByRemovingLevel,
  type Spindle,
  type SpindleView,
  storyMarkdown,
  suggestedLevel,
  SUMMARY_SYSTEM,
  type SummaryResult,
  type SynopsisIdeasResult,
  withBranch,
  withCardPin,
  withExtraPrompt,
  withLastLevelRemoved,
  withPinned,
  withRequested,
  withRespin,
} from "./story-logic.ts";

export type { Level, Spindle } from "./story-logic.ts";

// Every request names its model. The spindles are a high-volume map (four
// long options per card, a summary per pin), which suits a fast, cheap model;
// and the generateObject default (`gateway:gpt-5.4-mini`) runs in OpenAI's
// strict structured-output mode, which rejects the schemas the runtime derives
// from these result types (no `additionalProperties: false`, and toolshed's
// `normalizeSchemaForProvider` does not add it), so with no model named every
// request failed with HTTP 400.
const MODEL = "anthropic:claude-haiku-4-5" as const;

type RequestCard = SpindleView & { summaries: ReadonlyCell<string>[] };

/** Each map child owns one request. Reordering cards keeps the child; a
 * different prompt gets a new one, even when its path stays the same. */
function requestBoard(
  levels: readonly Level[],
  synopsis: string,
  spindles: readonly Spindle[],
) {
  return boardView(levels, synopsis, spindles).map((level) => ({
    ...level,
    spindles: level.spindles.map((spindle) =>
      Writable.for<RequestCard>({
        card: spindle.path,
        prompt: spindle.activePrompt,
      }).set({
        ...spindle,
        summaries: spindle.summaryPrompt
          ? [
            Writable.for<string>({
              summary: spindle.path,
              prompt: spindle.summaryPrompt,
            }).set(spindle.summaryPrompt),
          ]
          : [],
      })
    ),
  }));
}

const DEFAULT_LEVELS = [
  {
    title: "Characters & Themes",
    prompt:
      "Based on the synopsis, identify the main characters, key plot points, and central themes of this story.",
    branch: 1,
  },
  {
    title: "Chapters",
    prompt:
      "Write detailed chapter summaries that develop the characters and themes identified above.",
    branch: 1,
  },
];

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Colors come from the shell's theme, so the board reads in light and dark
// alike; the fallbacks are the light theme. A tint mixes an accent into the
// theme's background rather than naming a light pastel.
const TEXT = "var(--cf-theme-color-text, #111827)";
const MUTED = "var(--cf-theme-color-text-muted, #6b7280)";
const BORDER = "var(--cf-theme-color-border, #e5e7eb)";
const SURFACE = "var(--cf-theme-color-surface, #f9fafb)";
const BACKGROUND = "var(--cf-theme-color-background, #ffffff)";
const tint = (accent: string, percent: number): string =>
  `color-mix(in srgb, ${accent} ${percent}%, ${BACKGROUND})`;

const LEVEL_COLORS = ["#0ea5e9", "#eab308", "#22c55e", "#d946ef", "#f97316"];

const styles = {
  page: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
  title: { fontSize: "24px", fontWeight: "bold", width: "100%" },
  synopsisPanel: {
    padding: "16px",
    background: tint("#eab308", 10),
    color: TEXT,
    borderRadius: "8px",
    border: `1px solid ${tint("#eab308", 45)}`,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  sectionTitle: { fontWeight: "600", fontSize: "15px" },
  hint: { fontSize: "13px", color: MUTED, fontStyle: "italic" },
  primary: {
    padding: "8px 16px",
    background: "#2563eb",
    color: "white",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: "600",
  },
  secondary: {
    padding: "6px 12px",
    background: SURFACE,
    color: TEXT,
    border: `1px solid ${BORDER}`,
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "13px",
  },
  inspire: {
    padding: "8px 16px",
    background: "#8b5cf6",
    color: "white",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: "600",
  },
  ideas: {
    padding: "12px",
    background: tint("#8b5cf6", 10),
    color: TEXT,
    border: `1px solid ${tint("#8b5cf6", 40)}`,
    borderRadius: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  idea: {
    padding: "10px 12px",
    background: BACKGROUND,
    color: TEXT,
    border: `1px solid ${BORDER}`,
    borderRadius: "6px",
    cursor: "pointer",
    textAlign: "left",
  },
  level: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  levelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    flexWrap: "wrap",
    paddingBottom: "6px",
  },
  levelTitle: { fontWeight: "700", fontSize: "17px" },
  levelPrompt: { fontSize: "13px", color: MUTED, fontStyle: "italic" },
  stepper: {
    width: "28px",
    height: "28px",
    border: `1px solid ${BORDER}`,
    background: SURFACE,
    color: TEXT,
    borderRadius: "6px",
    cursor: "pointer",
  },
  editPanel: {
    padding: "12px",
    background: SURFACE,
    color: TEXT,
    border: `1px solid ${BORDER}`,
    borderRadius: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  warning: {
    padding: "8px 12px",
    background: tint("#f59e0b", 16),
    color: TEXT,
    border: `1px solid ${tint("#f59e0b", 50)}`,
    borderRadius: "6px",
    fontSize: "13px",
  },
  card: {
    background: SURFACE,
    color: TEXT,
    border: `1px solid ${BORDER}`,
    borderRadius: "8px",
    overflow: "hidden",
  },
  cardHeader: {
    padding: "10px 14px",
    borderBottom: `1px solid ${BORDER}`,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  cardBody: {
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  snippet: { fontSize: "12px", color: MUTED },
  options: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: "10px",
  },
  optionText: { maxHeight: "260px", overflow: "auto", fontSize: "14px" },
  centered: {
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "10px",
    color: MUTED,
    fontSize: "14px",
  },
  summary: {
    padding: "8px 12px",
    background: tint("#22c55e", 12),
    border: `1px solid ${tint("#22c55e", 40)}`,
    borderRadius: "6px",
    fontSize: "13px",
    color: TEXT,
  },
  prompt: {
    whiteSpace: "pre-wrap",
    fontSize: "12px",
    background: BACKGROUND,
    color: TEXT,
    padding: "8px",
    borderRadius: "6px",
    margin: "6px 0 0 0",
  },
  addLevel: {
    padding: "12px",
    border: `1px dashed ${BORDER}`,
    borderRadius: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
} as const;

const optionStyle = (pinned: boolean, dimmed: boolean) => ({
  padding: "12px",
  borderRadius: "8px",
  border: pinned ? "3px solid #2563eb" : `1px solid ${BORDER}`,
  background: pinned ? tint("#2563eb", 10) : BACKGROUND,
  color: TEXT,
  opacity: dimmed ? "0.55" : "1",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
});

const levelBorder = (index: number): string =>
  `4px solid ${LEVEL_COLORS[index % LEVEL_COLORS.length]}`;

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

interface StoryWeaverInput {
  title?: PerSpace<Writable<string | Default<"My Story Weaver">>>;
  /** The committed synopsis: the root every level builds on. */
  synopsis?: PerSpace<Writable<string | Default<"">>>;
  /** The synopsis being written; committed by Start story / Update synopsis. */
  synopsisDraft?: PerSpace<Writable<string | Default<"">>>;
  levels?: PerSpace<Writable<Level[] | Default<typeof DEFAULT_LEVELS>>>;
  spindles?: PerSpace<Writable<Spindle[] | Default<[]>>>;
}

/** Interactive story generation board with levels and spindles. #storyWeaver */
export interface StoryWeaverOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  title: string;
  synopsis: string;
  synopsisDraft: string;
  levels: Level[];
  spindles: Spindle[];
  /** Paths of the spindles on the board, level by level. */
  board: string[][];
  /** Commit the draft synopsis. */
  startStory: Stream<void>;
  /** Pin (or, for the pinned option, unpin) an option on a spindle. */
  pin: Stream<{ path: string; option: number; text: string }>;
  respin: Stream<{ path: string }>;
  generate: Stream<{ path: string }>;
  setExtraPrompt: Stream<{ path: string; text: string }>;
  setBranch: Stream<{ level: number; branch: number }>;
  addLevel: Stream<{ title: string; prompt: string }>;
  updateLevel: Stream<{ level: number; title: string; prompt: string }>;
  removeLastLevel: Stream<void>;
}

const StoryWeaver = pattern<StoryWeaverInput, StoryWeaverOutput>(
  ({ title, synopsis, synopsisDraft, levels, spindles }) => {
    // Transient UI state: per session.
    // Counts up for good, so every Inspire me asks for a fresh batch.
    const ideasAttempt = new Writable.perSession<number>(0);
    const ideasOpen = new Writable.perSession<boolean>(false);
    const editingLevel = new Writable.perSession<number | null>(null);
    const levelTitleDraft = new Writable.perSession<string>("");
    const levelPromptDraft = new Writable.perSession<string>("");
    const editingPrompt = new Writable.perSession<string | null>(null);
    const promptDraft = new Writable.perSession<string>("");
    // A change that would drop pinned spindles, waiting for a yes. Branch 0
    // means removing the level.
    const pendingBranch = new Writable.perSession<
      { level: number; branch: number; lost: number } | null
    >(null);
    const newLevelTitle = new Writable.perSession<string>("");
    const newLevelPrompt = new Writable.perSession<string>("");

    const board = computed(() =>
      requestBoard(levels.get(), synopsis.get(), spindles.get())
    );
    const boardPathList = computed(() =>
      board.map((level) => level.spindles.map((s) => s.key("path").get()))
    );

    const started = computed(() => synopsis.get().trim() !== "");
    const draftChanged = computed(() =>
      synopsisDraft.get().trim() !== "" &&
      synopsisDraft.get().trim() !== synopsis.get().trim()
    );
    const startLabel = computed(() =>
      started ? "Update synopsis" : "Start story →"
    );
    // A disabled button keeps its colors unless told otherwise, and looks
    // clickable.
    const startStyle = computed(() => ({
      ...styles.primary,
      opacity: draftChanged ? "1" : "0.5",
      cursor: draftChanged ? "pointer" : "default",
    }));
    const nextLevel = computed(() => suggestedLevel(levels.get().length));

    // --- Synopsis ------------------------------------------------------------

    const startStory = action(() => {
      const text = synopsisDraft.get().trim();
      if (text) synopsis.set(text);
    });

    const ideas = generateObject<SynopsisIdeasResult>({
      system: IDEAS_SYSTEM,
      model: MODEL,
      prompt: computed(() => ideasPrompt(ideasAttempt.get())),
    });
    const ideaView = computed(() => {
      const empty: SynopsisIdeasResult["ideas"] = [];
      if (isPending(ideas) || isSyncing(ideas)) {
        return { pending: true, error: "", list: empty };
      }
      if (hasError(ideas) || isObsolete(ideas)) {
        return {
          pending: false,
          error: ideas.message || "Story ideas are unavailable.",
          list: empty,
        };
      }
      return { pending: false, error: "", list: resultOf(ideas).ideas };
    });
    const inspire = action(() => {
      ideasAttempt.set(ideasAttempt.get() + 1);
      ideasOpen.set(true);
    });
    const chooseIdea = action((event: { synopsis: string }) => {
      synopsisDraft.set(event.synopsis);
      ideasOpen.set(false);
    });

    // --- Spindles ------------------------------------------------------------

    const pin = action(
      (event: { path: string; option: number; text: string }) => {
        if (!event.text) return;
        const all = spindles.get();
        spindles.set(
          withPinned(
            all,
            event.path,
            event.option,
            event.text,
            parentText(event.path, synopsis.get(), all),
          ),
        );
      },
    );
    const respin = action((event: { path: string }) =>
      spindles.set(withRespin(spindles.get(), event.path))
    );
    const pinAnswer = action((event: CardPin) => {
      const next = withCardPin(
        levels.get(),
        synopsis.get(),
        spindles.get(),
        event,
      );
      if (next) spindles.set(next);
    });
    const generate = action((event: { path: string }) =>
      spindles.set(withRequested(spindles.get(), event.path))
    );
    const setExtraPrompt = action((event: { path: string; text: string }) =>
      spindles.set(withExtraPrompt(spindles.get(), event.path, event.text))
    );

    const editPrompt = action((event: { path: string; text: string }) => {
      editingPrompt.set(event.path);
      promptDraft.set(event.text);
    });
    const savePrompt = action(() => {
      const path = editingPrompt.get();
      if (path !== null) {
        setExtraPrompt.send({ path, text: promptDraft.get().trim() });
      }
      editingPrompt.set(null);
    });
    const cancelPrompt = action(() => editingPrompt.set(null));

    // --- Levels --------------------------------------------------------------

    const setBranch = action((event: { level: number; branch: number }) => {
      const next = withBranch(
        levels.get(),
        spindles.get(),
        event.level,
        event.branch,
      );
      levels.set(next.levels);
      spindles.set(next.spindles);
      pendingBranch.set(null);
    });
    const removeLastLevel = action(() => {
      const next = withLastLevelRemoved(levels.get(), spindles.get());
      levels.set(next.levels);
      spindles.set(next.spindles);
      editingLevel.set(null);
      pendingBranch.set(null);
    });
    // The steppers: lowering a branch that would drop pinned spindles asks
    // first.
    const stepBranch = action((event: { level: number; delta: number }) => {
      const current = levels.get()[event.level];
      if (!current) return;
      const branch = clampBranch(current.branch + event.delta);
      if (branch === current.branch) return;
      const lost = pinsLostByBranch(
        levels.get(),
        synopsis.get(),
        spindles.get(),
        event.level,
        branch,
      );
      if (lost > 0) {
        pendingBranch.set({ level: event.level, branch, lost });
      } else {
        setBranch.send({ level: event.level, branch });
      }
    });
    const confirmBranch = action(() => {
      const pending = pendingBranch.get();
      if (pending && pending.branch === 0) removeLastLevel.send();
      else if (pending) {
        setBranch.send({ level: pending.level, branch: pending.branch });
      }
    });
    const cancelBranch = action(() => pendingBranch.set(null));
    const pendingMessage = computed(() => {
      const pending = pendingBranch.get();
      const lost = `${pending?.lost} pinned spindle${
        pending?.lost === 1 ? "" : "s"
      }`;
      return !pending
        ? ""
        : pending.branch === 0
        ? `Removing this level removes ${lost}.`
        : `Lowering to ${pending.branch} removes ${lost} and everything under ${
          pending.lost === 1 ? "it" : "them"
        }.`;
    });
    const pendingLevel = computed(() => pendingBranch.get()?.level ?? -1);

    const addLevel = action((event: { title: string; prompt: string }) => {
      const suggestion = suggestedLevel(levels.get().length);
      levels.set([...levels.get(), {
        title: event.title.trim() || suggestion.title,
        prompt: event.prompt.trim() || suggestion.prompt,
        branch: 1,
      }]);
    });
    const addLevelFromForm = action(() => {
      addLevel.send({
        title: newLevelTitle.get(),
        prompt: newLevelPrompt.get(),
      });
      newLevelTitle.set("");
      newLevelPrompt.set("");
    });

    const updateLevel = action(
      (event: { level: number; title: string; prompt: string }) => {
        levels.set(
          levels.get().map((l, i) =>
            i === event.level
              ? {
                ...l,
                title: event.title.trim() || l.title,
                prompt: event.prompt.trim(),
              }
              : l
          ),
        );
      },
    );
    const editLevel = action((event: { level: number }) => {
      const level = levels.get()[event.level];
      if (!level) return;
      editingLevel.set(event.level);
      levelTitleDraft.set(level.title);
      levelPromptDraft.set(level.prompt);
    });
    const saveLevel = action(() => {
      const level = editingLevel.get();
      if (level !== null) {
        updateLevel.send({
          level,
          title: levelTitleDraft.get(),
          prompt: levelPromptDraft.get(),
        });
      }
      editingLevel.set(null);
    });
    const cancelLevel = action(() => editingLevel.set(null));

    const askRemoveLastLevel = action(() => {
      const lost = pinsLostByRemovingLevel(
        levels.get(),
        synopsis.get(),
        spindles.get(),
      );
      if (lost > 0) {
        pendingBranch.set({ level: levels.get().length - 1, branch: 0, lost });
      } else {
        removeLastLevel.send();
      }
    });

    const editingLevelIndex = computed(() => editingLevel.get() ?? -1);
    const editingPromptPath = computed(() => editingPrompt.get() ?? "");

    const fsContent = computed(() =>
      storyMarkdown(title.get(), levels.get(), synopsis.get(), spindles.get())
    );

    const synopsisPanel = (
      <div style={styles.synopsisPanel}>
        <div style={styles.sectionTitle}>Synopsis</div>
        <cf-textarea
          $value={synopsisDraft}
          placeholder="Enter your story synopsis or seed idea..."
          rows={4}
          autoResize
        />
        <div style={styles.row}>
          <button
            type="button"
            onClick={startStory}
            disabled={!draftChanged}
            style={startStyle}
          >
            {startLabel}
          </button>
          <button type="button" onClick={inspire} style={styles.inspire}>
            ✨ Inspire me
          </button>
          {started
            ? (
              <span style={styles.hint}>
                Updating the synopsis rebuilds the first level and marks the
                pins built on the old one stale.
              </span>
            )
            : null}
        </div>
        {ideasOpen
          ? (
            <div style={styles.ideas}>
              <div style={{ fontWeight: "600", color: "#8b5cf6" }}>
                ✨ Story ideas
              </div>
              {ideaView.pending
                ? (
                  <div style={styles.row}>
                    <cf-loader size="sm" showElapsed /> Generating ideas...
                  </div>
                )
                : ideaView.error
                ? (
                  <div style={styles.hint}>
                    Couldn't get ideas: {ideaView.error}
                  </div>
                )
                : null}
              {ideaView.list.map((idea) => (
                <button
                  type="button"
                  onClick={() => chooseIdea.send({ synopsis: idea.synopsis })}
                  style={styles.idea}
                >
                  <div style={{ fontWeight: "600", marginBottom: "4px" }}>
                    {idea.title}
                  </div>
                  <div style={{ fontSize: "13px", color: MUTED }}>
                    {idea.synopsis}
                  </div>
                </button>
              ))}
            </div>
          )
          : null}
      </div>
    );

    const levelsView = board.map((level) => (
      <div style={{ ...styles.level, borderLeft: levelBorder(level.index) }}>
        <div style={{ paddingLeft: "12px" }}>
          <div style={styles.levelHeader}>
            <span style={styles.levelTitle}>{level.title}</span>
            <div style={styles.row}>
              <span style={{ fontSize: "13px", color: MUTED }}>
                Branches
              </span>
              <button
                type="button"
                aria-label={`Fewer ${level.title} per parent`}
                onClick={() =>
                  stepBranch.send({ level: level.index, delta: -1 })}
                disabled={level.branch <= 1}
                style={styles.stepper}
              >
                −
              </button>
              <span>{level.branch}</span>
              <button
                type="button"
                aria-label={`More ${level.title} per parent`}
                onClick={() =>
                  stepBranch.send({ level: level.index, delta: 1 })}
                disabled={level.branch >= MAX_BRANCH}
                style={styles.stepper}
              >
                +
              </button>
              <button
                type="button"
                onClick={() => editLevel.send({ level: level.index })}
                style={styles.secondary}
              >
                Edit level
              </button>
              {level.isLast
                ? (
                  <button
                    type="button"
                    onClick={askRemoveLastLevel}
                    style={styles.secondary}
                  >
                    Remove level
                  </button>
                )
                : null}
            </div>
          </div>
          {level.prompt
            ? <div style={styles.levelPrompt}>{level.prompt}</div>
            : null}
        </div>

        {pendingLevel === level.index
          ? (
            <div style={{ ...styles.warning, marginLeft: "12px" }}>
              <div>{pendingMessage}</div>
              <div style={{ ...styles.row, marginTop: "6px" }}>
                <button
                  type="button"
                  onClick={confirmBranch}
                  style={styles.secondary}
                >
                  Remove them
                </button>
                <button
                  type="button"
                  onClick={cancelBranch}
                  style={styles.secondary}
                >
                  Keep
                </button>
              </div>
            </div>
          )
          : null}

        {editingLevelIndex === level.index
          ? (
            <div style={{ ...styles.editPanel, marginLeft: "12px" }}>
              <cf-input $value={levelTitleDraft} placeholder="Level title" />
              <cf-textarea
                $value={levelPromptDraft}
                placeholder="What should each spindle at this level write?"
                rows={3}
                autoResize
              />
              <div style={styles.row}>
                <button
                  type="button"
                  onClick={saveLevel}
                  style={styles.primary}
                >
                  Save level
                </button>
                <button
                  type="button"
                  onClick={cancelLevel}
                  style={styles.secondary}
                >
                  Cancel
                </button>
              </div>
            </div>
          )
          : null}

        {level.spindles.length === 0
          ? (
            <div style={{ ...styles.hint, paddingLeft: "12px" }}>
              {level.index === 0
                ? "Start the story to generate options here."
                : "Pin an option on the level above to continue here."}
            </div>
          )
          : null}

        {level.spindles.map((card) => {
          const spindle = computed(() => card.get());
          const generation = generateObject<GenerationResult>({
            system: OPTIONS_SYSTEM,
            model: MODEL,
            // Four options of up to 400 words fit well inside this.
            maxTokens: 12000,
            prompt: spindle.activePrompt,
          });
          const answer = computed(() => {
            const empty: GenerationResult["options"] = [];
            if (isPending(generation) || isSyncing(generation)) {
              return { waiting: true, failed: "", options: empty };
            }
            if (hasError(generation) || isObsolete(generation)) {
              return {
                waiting: false,
                failed: generation.message || "Story options are unavailable.",
                options: empty,
              };
            }
            return {
              waiting: false,
              failed: "",
              options: resultOf(generation).options,
            };
          });
          const options = computed(() =>
            answer.options.map((o, index) => ({
              index,
              text: o?.content ?? "",
              pinned: spindle.pinned === index &&
                spindle.pinnedText === o?.content,
              dimmed: spindle.pinnedText !== "" &&
                spindle.pinnedText !== o?.content,
            }))
              .filter((o) => o.text !== "")
          );
          // The pin is not among the options on show: they wait for a click,
          // or the parent changed and they were rebuilt.
          const pinnedAside = computed(() =>
            spindle.pinnedText !== "" && !options.some((o) => o.pinned)
          );
          return (
            <div style={{ ...styles.card, marginLeft: "12px" }}>
              {spindle.staleAbove
                ? (
                  <div style={styles.warning}>
                    ⚠️ Stale: a pin further up is stale. Respin that one first;
                    this one's own parent has not changed.
                  </div>
                )
                : spindle.stale
                ? (
                  <div style={styles.warning}>
                    ⚠️ Stale: the text above changed since this was pinned.
                    Respin for options built on the new text.
                  </div>
                )
                : null}
              <div style={styles.cardHeader}>
                <div>
                  <div style={{ fontWeight: "600" }}>{spindle.label}</div>
                  {spindle.parentSnippet
                    ? (
                      <div style={styles.snippet}>
                        from “{spindle.parentSnippet}”
                      </div>
                    )
                    : null}
                </div>
                <div style={styles.row}>
                  <button
                    type="button"
                    onClick={() =>
                      editPrompt.send({
                        path: spindle.path,
                        text: spindle.extraPrompt,
                      })}
                    style={styles.secondary}
                  >
                    {spindle.extraPrompt
                      ? "Edit instruction"
                      : "Add instruction"}
                  </button>
                  {spindle.ready
                    ? (
                      <button
                        type="button"
                        onClick={() => respin.send({ path: spindle.path })}
                        style={styles.secondary}
                      >
                        🔄 Respin
                      </button>
                    )
                    : null}
                </div>
              </div>
              <div style={styles.cardBody}>
                {editingPromptPath === spindle.path
                  ? (
                    <div style={styles.editPanel}>
                      <cf-textarea
                        $value={promptDraft}
                        placeholder="An extra instruction for this spindle only"
                        rows={2}
                        autoResize
                      />
                      <div style={styles.row}>
                        <button
                          type="button"
                          onClick={savePrompt}
                          style={styles.primary}
                        >
                          Save instruction
                        </button>
                        <button
                          type="button"
                          onClick={cancelPrompt}
                          style={styles.secondary}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )
                  : spindle.extraPrompt
                  ? (
                    <div style={styles.levelPrompt}>
                      Instruction: {spindle.extraPrompt}
                    </div>
                  )
                  : null}

                {!spindle.ready
                  ? (
                    <div style={styles.centered}>
                      <div>Ready to generate options</div>
                      <button
                        type="button"
                        onClick={() => generate.send({ path: spindle.path })}
                        style={styles.primary}
                      >
                        Generate options
                      </button>
                    </div>
                  )
                  : answer.waiting
                  ? (
                    <div style={styles.centered}>
                      <cf-loader size="lg" showElapsed />
                      <div>Generating options...</div>
                    </div>
                  )
                  : answer.failed
                  ? (
                    <div style={styles.warning}>
                      Couldn't generate options: {answer.failed}
                    </div>
                  )
                  : (
                    <div style={styles.options}>
                      {options.map((option) => (
                        <div style={optionStyle(option.pinned, option.dimmed)}>
                          <div style={styles.row}>
                            <span
                              style={{ fontSize: "12px", color: MUTED }}
                            >
                              Option {option.index + 1}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                pinAnswer.send({
                                  path: spindle.path,
                                  prompt: spindle.activePrompt,
                                  unpin: option.pinned,
                                  option: option.index,
                                  text: option.text,
                                })}
                              style={styles.secondary}
                            >
                              {option.pinned ? "Unpin" : "📌 Pin"}
                            </button>
                          </div>
                          <div style={styles.optionText}>
                            <cf-markdown content={option.text} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                {pinnedAside
                  ? (
                    <div style={optionStyle(true, false)}>
                      <div style={styles.row}>
                        <span
                          style={{
                            fontSize: "12px",
                            color: "var(--cf-theme-color-primary, #2563eb)",
                          }}
                        >
                          📌 Pinned
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            pinAnswer.send({
                              path: spindle.path,
                              prompt: spindle.activePrompt,
                              unpin: true,
                              option: spindle.pinned,
                              text: spindle.pinnedText,
                            })}
                          style={styles.secondary}
                        >
                          Unpin
                        </button>
                      </div>
                      <cf-markdown content={spindle.pinnedText} />
                    </div>
                  )
                  : null}

                {spindle.summaries.map((request) => {
                  const summary = generateObject<SummaryResult>({
                    system: SUMMARY_SYSTEM,
                    model: MODEL,
                    prompt: computed(() => request.get()),
                  });
                  const text = computed(() => {
                    if (isPending(summary) || isSyncing(summary)) {
                      return " Summarizing...";
                    }
                    if (
                      hasError(summary) || isObsolete(summary)
                    ) return summary.message || "Summary unavailable.";
                    return resultOf(summary).summary;
                  });
                  return (
                    <div style={styles.summary}>
                      <strong>Summary:</strong> {text}
                    </div>
                  );
                })}

                <details>
                  <summary style={{ fontSize: "12px", color: MUTED }}>
                    View prompt
                  </summary>
                  <pre style={styles.prompt}>{spindle.prompt}</pre>
                </details>
              </div>
            </div>
          );
        })}
      </div>
    ));

    const addLevelPanel = (
      <div style={styles.addLevel}>
        <div style={styles.sectionTitle}>Add a level</div>
        <cf-input $value={newLevelTitle} placeholder={nextLevel.title} />
        <cf-textarea
          $value={newLevelPrompt}
          placeholder={nextLevel.prompt}
          rows={2}
          autoResize
        />
        <div>
          <button
            type="button"
            onClick={addLevelFromForm}
            style={styles.primary}
          >
            + Add level
          </button>
        </div>
      </div>
    );

    return {
      [NAME]: computed(() => `📖 ${title.get()}`),
      [UI]: (
        <cf-screen>
          <cf-vscroll flex showScrollbar>
            <div style={styles.page}>
              <cf-input
                $value={title}
                placeholder="Story title"
                style={styles.title}
              />
              {synopsisPanel}
              {levelsView}
              {addLevelPanel}
            </div>
          </cf-vscroll>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title },
        content: fsContent,
      },
      title,
      synopsis,
      synopsisDraft,
      levels,
      spindles,
      board: boardPathList,
      startStory,
      pin,
      respin,
      generate,
      setExtraPrompt,
      setBranch,
      addLevel,
      updateLevel,
      removeLastLevel,
    };
  },
);

export default StoryWeaver;

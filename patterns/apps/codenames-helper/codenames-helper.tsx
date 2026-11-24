/**
 * Codenames Helper — a spymaster's companion for playing the word game
 * Codenames in person, with the physical cards on the table.
 *
 * Setup: enter the 25 board words and the key card's colors, by typing them
 * into the grid (tap a card, then a color) or by photographing the board and
 * the key card and letting an LLM read them. Play: tap a card when it is
 * guessed to mark it out of play, and ask for clue ideas that connect your
 * team's remaining words while steering clear of the rest.
 *
 * Ported from jkomoros/community-patterns (`codenames-helper.tsx`). The board
 * logic now lives in `board.ts` as pure functions. Clue ideas are requested
 * with a button rather than regenerated on every reveal (asking again about
 * the same board asks for different ideas), a guessed card can be tapped again
 * to undo a mis-tap, and each viewer picks their own team. The photo
 * "corrections" box, which was never sent to the model, is gone: fix a
 * misread card in the grid.
 */
import {
  action,
  computed,
  Default,
  FS,
  generateObject,
  handler,
  hasError,
  isObsolete,
  isPending,
  isSyncing,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  resultOf,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  applyReading,
  type BoardCard,
  boardMarkdown,
  buildCluePrompt,
  checkReading,
  CLUE_SYSTEM_PROMPT,
  type ClueIdea,
  cluesFrom,
  type ClueSuggestions,
  keyIssues,
  type Mode,
  normalizeBoard,
  type Owner,
  ownerCounts,
  OWNERS,
  PHOTO_SYSTEM_PROMPT,
  PHOTO_USER_PROMPT,
  type PhotoReading,
  readingGrid,
  type Team,
  withColorsCleared,
  withOwner,
  withRevealToggled,
  withRound,
  withWord,
} from "./board.ts";

export type { BoardCard, Mode, Owner, PhotoReading, Team } from "./board.ts";

// ---------------------------------------------------------------------------
// Styles (above the pattern: its body runs at module load)
// ---------------------------------------------------------------------------

const FILL: Record<Owner, string> = {
  red: "#dc2626",
  blue: "#2563eb",
  neutral: "#d6d3d1",
  assassin: "#111827",
  unassigned: "#f3f4f6",
};

const INK: Record<Owner, string> = {
  red: "#ffffff",
  blue: "#ffffff",
  neutral: "#1c1917",
  assassin: "#ffffff",
  unassigned: "#1c1917",
};

const OWNER_LABEL: Record<Owner, string> = {
  red: "Red",
  blue: "Blue",
  neutral: "Neutral",
  assassin: "Assassin",
  unassigned: "Clear",
};

const styles = {
  page: {
    padding: "16px",
    fontFamily: "system-ui, sans-serif",
    maxWidth: "640px",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  title: { fontSize: "20px", fontWeight: "bold", textAlign: "center" },
  row: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: "4px",
  },
  wordLabel: {
    fontSize: "11px",
    fontWeight: "600",
    textAlign: "center",
    wordBreak: "break-word",
  },
  // The panels are light in either theme, so they set their own text color
  // rather than inheriting the shell's (light text in dark mode).
  panel: {
    padding: "12px",
    background: "#f9fafb",
    color: "#111827",
    borderRadius: "8px",
    border: "1px solid #e5e7eb",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  panelTitle: { fontSize: "14px", fontWeight: "600" },
  hint: { fontSize: "12px", color: "#6b7280" },
  stack: { display: "flex", flexDirection: "column", gap: "6px" },
  warning: { fontSize: "12px", color: "#92400e" },
  error: { fontSize: "12px", color: "#991b1b" },
  counts: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
    fontSize: "12px",
    fontWeight: "600",
  },
  button: {
    padding: "8px 14px",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#111827",
    fontWeight: "600",
    cursor: "pointer",
  },
  primary: {
    padding: "8px 14px",
    borderRadius: "6px",
    border: "none",
    background: "#4f46e5",
    color: "#ffffff",
    fontWeight: "600",
    cursor: "pointer",
  },
  danger: {
    padding: "8px 14px",
    borderRadius: "6px",
    border: "1px solid #fca5a5",
    background: "#ffffff",
    color: "#b91c1c",
    fontWeight: "600",
    cursor: "pointer",
  },
  photoCard: {
    padding: "10px",
    background: "#ffffff",
    borderRadius: "6px",
    border: "1px solid #e5e7eb",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  miniGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: "2px",
    maxWidth: "260px",
  },
  clueCard: {
    padding: "10px",
    background: "#ffffff",
    borderRadius: "6px",
    border: "1px solid #fcd34d",
  },
  clueWord: { fontSize: "18px", fontWeight: "bold", color: "#92400e" },
  clueDetail: { fontSize: "12px", color: "#57534e", marginTop: "4px" },
} as const;

const teamButton = (team: Team, active: boolean) => ({
  ...styles.button,
  border: `2px solid ${FILL[team]}`,
  background: active ? FILL[team] : "#ffffff",
  color: active ? "#ffffff" : FILL[team],
});

const swatchButton = (owner: Owner) => ({
  ...styles.button,
  background: FILL[owner],
  color: INK[owner],
  border: "1px solid #111827",
});

const cardStyle = (owner: Owner, revealed: boolean, selected: boolean) => ({
  aspectRatio: "1",
  borderRadius: "6px",
  padding: "4px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  // Played cards are buttons: take the page's font, fill the grid cell.
  font: "inherit",
  width: "100%",
  background: FILL[owner],
  color: INK[owner],
  opacity: revealed ? "0.25" : "1",
  border: selected ? "3px solid #f59e0b" : "2px solid #111827",
  boxShadow: selected ? "0 0 0 2px #fde68a" : "none",
});

/** The word input's own box is in cf-input's shadow DOM; its colors come from
 * these custom properties, so the card color shows through. */
const wordInputStyle = (owner: Owner) => ({
  width: "100%",
  textAlign: "center",
  fontSize: "11px",
  fontWeight: "600",
  textTransform: "uppercase",
  "--cf-input-color-background": "transparent",
  "--cf-input-color-border": "transparent",
  // A filled input otherwise draws cf-input's green "valid" border.
  "--cf-input-color-success": "transparent",
  "--cf-input-color-text": INK[owner],
});

const miniCellStyle = (owner: Owner) => ({
  aspectRatio: "1",
  background: FILL[owner],
  color: INK[owner],
  border: "1px solid #d1d5db",
  borderRadius: "2px",
  fontSize: "7px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
});

/**
 * The model both LLM calls use, named rather than left to a default because
 * neither default returns structured output today (runtime problem, not this
 * pattern's): the "default" alias resolves to gateway:claude-sonnet-5, which
 * the gateway's provider refuses structured outputs for, and generateObject's
 * own default (gateway:gpt-5.4-mini) rejects any schema that does not set
 * `additionalProperties: false` on every object, which toolshed does not add
 * (top/3114). Haiku 4.5 reads images, and read a test board and key card
 * exactly. Go back to the default once one of them answers generateObject.
 */
const STRUCTURED_MODEL = "anthropic:claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

interface CardView {
  index: number;
  word: string;
  label: string;
  revealed: boolean;
  style: Record<string, string>;
  inputStyle: Record<string, string>;
}

interface CodenamesHelperInput {
  board?: PerSpace<Writable<BoardCard[] | Default<[]>>>;
  /** Each spymaster's own team, so two sharing one board don't flip it for
   * each other. */
  myTeam?: PerUser<Writable<Team | Default<"red">>>;
  mode?: PerSpace<Writable<Mode | Default<"setup">>>;
}

export interface CodenamesHelperOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  /** Always 25 cards, row-major from the top left. */
  board: BoardCard[];
  myTeam: Team;
  mode: Mode;
  /** The card picked for coloring in setup, or -1. */
  selectedIndex: number;
  /** Cards of each color still in play. */
  inPlay: Record<Owner, number>;
  /** What is off about the colors entered so far; empty when the key looks
   * complete. */
  keyWarnings: string[];
  /** The board prompt clue ideas were last requested for, or "". */
  clueRequest: string;
  /** Setup: pick the card to color. Play: mark it guessed, or undo that. */
  tapCard: Stream<{ index: number }>;
  /** Give the picked card a key color. */
  assignOwner: Stream<{ owner: Owner }>;
  setWord: Stream<{ index: number; word: string }>;
  /** Apply what the LLM read from a board or key-card photo. */
  applyPhotoReading: Stream<{ reading: PhotoReading; photoId?: string }>;
  clearColors: Stream<void>;
  resetBoard: Stream<void>;
  startPlay: Stream<void>;
  editBoard: Stream<void>;
  requestClues: Stream<void>;
}

/**
 * The parts of an uploaded image this pattern uses. Not `ImageData`: a live
 * cf-image-input upload reaches a handler without the `timestamp` that
 * `ImageData` requires (runtime problem: the browser's event detail has it,
 * the handler's does not), and an event that fails its schema arrives as an
 * empty `detail`, so no photo was ever added. Go back to `ImageData` once
 * `timestamp` crosses.
 */
interface PhotoFile {
  id: string;
  name: string;
  url?: string;
  data?: string;
  type?: string;
  size?: number;
}

type ImageUploadEvent = {
  detail?: { images?: PhotoFile[]; files?: PhotoFile[] };
};

const tapCardHandler = handler<
  { index: number },
  {
    board: Writable<BoardCard[]>;
    mode: Writable<Mode>;
    selectedIndex: Writable<number>;
  }
>(({ index }, { board, mode, selectedIndex }) => {
  if (mode.get() === "play") {
    board.set(withRevealToggled(board.get(), index));
  } else {
    selectedIndex.set(index);
  }
});

const assignOwnerHandler = handler<
  { owner: Owner },
  { board: Writable<BoardCard[]>; selectedIndex: Writable<number> }
>(({ owner }, { board, selectedIndex }) => {
  const index = selectedIndex.get();
  if (index < 0) return;
  board.set(withOwner(board.get(), index, owner));
  selectedIndex.set(-1);
});

const setWordHandler = handler<
  { index: number; word: string },
  { board: Writable<BoardCard[]> }
>(({ index, word }, { board }) => {
  board.set(withWord(board.get(), index, word ?? ""));
});

type PhotoStatus = Record<string, "applied" | "discarded">;

// Photos are marked rather than removed from the list: removing one would
// shift the others' positions in the mapped list and make them read again.
const applyReadingHandler = handler<
  { reading: PhotoReading; photoId?: string },
  { board: Writable<BoardCard[]>; photoStatus: Writable<PhotoStatus> }
>(({ reading, photoId }, { board, photoStatus }) => {
  if (checkReading(reading).errors.length > 0) return;
  board.set(applyReading(board.get(), reading));
  if (photoId) photoStatus.set({ ...photoStatus.get(), [photoId]: "applied" });
});

const discardPhotoHandler = handler<
  { photoId: string },
  { photoStatus: Writable<PhotoStatus> }
>(({ photoId }, { photoStatus }) => {
  photoStatus.set({ ...photoStatus.get(), [photoId]: "discarded" });
});

const addPhotosHandler = handler<
  ImageUploadEvent,
  { photos: Writable<PhotoFile[]> }
>(({ detail }, { photos }) => {
  const added = detail?.images ?? detail?.files ?? [];
  if (added.length > 0) photos.set([...photos.get(), ...added]);
});

const CodenamesHelper = pattern<CodenamesHelperInput, CodenamesHelperOutput>(
  ({ board, myTeam, mode }) => {
    const selectedIndex = new Writable.perSession<number>(-1);
    const photos = new Writable.perSession<PhotoFile[]>([]);
    const photoStatus = new Writable.perSession<PhotoStatus>({});
    /** The clue prompt last asked for. Clue ideas are on demand, so a reveal
     * does not start a new LLM call by itself. */
    const clueRequest = new Writable.perSession<string>("");
    /** How many times ideas were asked for this same board, so asking again
     * yields new ideas rather than the cached answer. */
    const clueRound = new Writable.perSession<number>(0);

    const cards = computed(() => normalizeBoard(board.get()));
    const isSetup = computed(() => mode.get() !== "play");

    const cardViews = computed((): CardView[] => {
      const selected = mode.get() === "play" ? -1 : selectedIndex.get();
      return cards.map((card, index) => ({
        index,
        word: card.word,
        label: card.word || "—",
        revealed: card.revealed,
        style: cardStyle(card.owner, card.revealed, index === selected),
        inputStyle: wordInputStyle(card.owner),
      }));
    });

    const counts = computed(() => ownerCounts(cards));
    const inPlay = computed(() => ownerCounts(cards, true));
    const keyWarnings = computed(() =>
      counts.unassigned === 0 ? keyIssues(counts) : []
    );
    const countsLine = computed(() =>
      `Red ${counts.red} · Blue ${counts.blue} · Neutral ${counts.neutral} · Assassin ${counts.assassin} · Unassigned ${counts.unassigned}`
    );
    const inPlayLine = computed(() =>
      `Left in play: Red ${inPlay.red} · Blue ${inPlay.blue}`
    );
    const selectedLine = computed(() => {
      const index = selectedIndex.get();
      if (index < 0) return "Tap a card, then pick its color.";
      const word = cards[index]?.word || "this card";
      return `Coloring ${word} (row ${Math.floor(index / 5) + 1}, column ${
        (index % 5) + 1
      })`;
    });

    // --- Actions --------------------------------------------------------

    const tapCard = tapCardHandler({ board, mode, selectedIndex });
    const setWord = setWordHandler({ board });
    const applyPhotoReading = applyReadingHandler({ board, photoStatus });

    const assignOwner = assignOwnerHandler({ board, selectedIndex });

    const clearColors = action(() => {
      board.set(withColorsCleared(board.get()));
      selectedIndex.set(-1);
    });
    const resetBoard = action(() => {
      board.set(normalizeBoard([]));
      mode.set("setup");
      selectedIndex.set(-1);
      clueRequest.set("");
      clueRound.set(0);
      photos.set([]);
      photoStatus.set({});
    });
    const startPlay = action(() => {
      mode.set("play");
      selectedIndex.set(-1);
    });
    const editBoard = action(() => mode.set("setup"));
    const chooseRed = action(() => myTeam.set("red"));
    const chooseBlue = action(() => myTeam.set("blue"));
    const requestClues = action(() => {
      const prompt = buildCluePrompt(board.get(), myTeam.get());
      clueRound.set(prompt === clueRequest.get() ? clueRound.get() + 1 : 0);
      clueRequest.set(prompt);
    });
    const addPhotos = addPhotosHandler({ photos });
    const discardPhoto = discardPhotoHandler({ photoStatus });

    // --- LLM: photo reading ---------------------------------------------

    const readings = photos.map((photo, photoIndex) => {
      const reading = generateObject<PhotoReading>({
        model: STRUCTURED_MODEL,
        system: PHOTO_SYSTEM_PROMPT,
        prompt: computed(() => {
          const image = photo?.data || photo?.url;
          if (!image) return [];
          return [
            { type: "image" as const, image },
            { type: "text" as const, text: PHOTO_USER_PROMPT },
          ];
        }),
      });
      const photoId = computed(() => photo?.id || photo?.url || "");
      const view = computed(() => {
        const waiting = isPending(reading) || isSyncing(reading);
        const error = hasError(reading)
          ? reading.message || "The photo analysis failed."
          : isObsolete(reading)
          ? reading.message || "This photo reading is no longer available."
          : "";
        const result = waiting || error ? undefined : resultOf(reading);
        const status = photoStatus.get()[photo?.id || photo?.url || ""];
        const check = checkReading(result);
        return {
          title: `Photo ${photoIndex + 1}: ${
            result?.kind === "board"
              ? "board"
              : result?.kind === "keycard"
              ? "key card"
              : "unrecognized"
          }`,
          errors: check.errors,
          warnings: check.warnings,
          notes: typeof result?.notes === "string" ? result.notes : "",
          result,
          waiting,
          error,
          canApply: check.errors.length === 0,
          applied: status === "applied",
          hidden: status === "discarded",
          cells: readingGrid(result).map((cell) => ({
            text: cell.word.slice(0, 8),
            style: miniCellStyle(cell.owner),
          })),
        };
      });
      return { photoIndex, photoId, view };
    });

    // --- LLM: clue ideas ------------------------------------------------

    const clueIdeas = generateObject<ClueSuggestions>({
      model: STRUCTURED_MODEL,
      system: CLUE_SYSTEM_PROMPT,
      prompt: computed(() => withRound(clueRequest.get(), clueRound.get())),
    });
    const clues = computed(() => {
      const waiting = isPending(clueIdeas) || isSyncing(clueIdeas);
      const error = hasError(clueIdeas)
        ? clueIdeas.message || "The clue request failed."
        : isObsolete(clueIdeas)
        ? clueIdeas.message || "These clue suggestions are no longer available."
        : "";
      return {
        waiting,
        error,
        ideas: waiting || error
          ? [] as ClueIdea[]
          : cluesFrom(resultOf(clueIdeas), cards, myTeam.get()),
      };
    });
    const hasRequest = computed(() => clueRequest.get() !== "");
    const cluesStale = computed(() =>
      clueRequest.get() !== "" &&
      clueRequest.get() !== buildCluePrompt(cards, myTeam.get())
    );
    const noWordsLeft = computed(() =>
      buildCluePrompt(cards, myTeam.get()) === ""
    );

    const fsContent = computed(() =>
      boardMarkdown(cards, myTeam.get(), mode.get())
    );

    // --- Views ----------------------------------------------------------

    const setupPanel = (
      <div style={styles.panel}>
        <div style={styles.panelTitle}>Key colors</div>
        <div style={styles.hint}>{selectedLine}</div>
        <div style={styles.row}>
          {OWNERS.map((owner) => (
            <button
              type="button"
              style={swatchButton(owner)}
              onClick={() => assignOwner.send({ owner })}
            >
              {OWNER_LABEL[owner]}
            </button>
          ))}
        </div>
        <div style={styles.counts}>{countsLine}</div>
        {keyWarnings.map((warning) => (
          <div style={styles.warning}>⚠ {warning}</div>
        ))}
        <div style={styles.row}>
          <button type="button" style={styles.button} onClick={clearColors}>
            Clear colors
          </button>
          <button type="button" style={styles.primary} onClick={startPlay}>
            Start playing
          </button>
        </div>

        <div style={styles.panelTitle}>Read from photos</div>
        <div style={styles.hint}>
          Photograph the board and the key card; check each reading, then apply
          it. Fix any misread card in the grid above.
        </div>
        <cf-image-input
          multiple
          maxSizeBytes={4000000}
          includeData
          showPreview={false}
          buttonText="📷 Add board or key card photos"
          variant="secondary"
          oncf-change={addPhotos}
        />
        {readings.map(({ photoIndex, photoId, view }) =>
          view.hidden ? null : view.applied
            ? (
              <div style={styles.hint}>
                ✓ Photo {photoIndex + 1} applied to the board
              </div>
            )
            : (
              <div style={styles.photoCard}>
                {view.waiting
                  ? (
                    <div style={styles.row}>
                      <cf-loader size="sm" showElapsed></cf-loader>
                      Reading photo {photoIndex + 1}...
                    </div>
                  )
                  : view.error
                  ? (
                    <div style={styles.error}>
                      Photo {photoIndex + 1} could not be read: {view.error}
                    </div>
                  )
                  : (
                    <div style={styles.stack}>
                      <div style={styles.panelTitle}>{view.title}</div>
                      <div style={styles.miniGrid}>
                        {view.cells.map((cell) => (
                          <div style={cell.style}>{cell.text}</div>
                        ))}
                      </div>
                      {view.errors.map((e) => (
                        <div style={styles.error}>✗ {e}</div>
                      ))}
                      {view.warnings.map((w) => (
                        <div style={styles.warning}>⚠ {w}</div>
                      ))}
                      {view.notes
                        ? <div style={styles.hint}>Note: {view.notes}</div>
                        : null}
                    </div>
                  )}
                <div style={styles.row}>
                  <button
                    type="button"
                    style={styles.primary}
                    disabled={!view.canApply}
                    onClick={() => {
                      if (view.canApply && view.result) {
                        applyPhotoReading.send({
                          reading: view.result,
                          photoId,
                        });
                      }
                    }}
                  >
                    Apply to board
                  </button>
                  <button
                    type="button"
                    style={styles.button}
                    onClick={() => discardPhoto.send({ photoId })}
                  >
                    Discard
                  </button>
                </div>
              </div>
            )
        )}
      </div>
    );

    const playPanel = (
      <div style={styles.panel}>
        <div style={styles.hint}>
          Tap a card when it is guessed to mark it out of play; tap it again to
          undo.
        </div>
        <div style={styles.counts}>{inPlayLine}</div>
        <div style={styles.panelTitle}>Clue ideas</div>
        <div style={styles.row}>
          <button
            type="button"
            style={styles.primary}
            disabled={noWordsLeft}
            onClick={requestClues}
          >
            Suggest clues
          </button>
        </div>
        {noWordsLeft
          ? <div style={styles.hint}>Your team has no words left in play.</div>
          : null}
        {cluesStale
          ? (
            <div style={styles.warning}>
              The board changed since these ideas; ask again for fresh ones.
            </div>
          )
          : null}
        {hasRequest
          ? (clues.waiting
            ? (
              <div style={styles.row}>
                <cf-loader showElapsed></cf-loader>
                Thinking of clues...
              </div>
            )
            : clues.error
            ? <div style={styles.error}>No clues: {clues.error}</div>
            : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                {clues.ideas.map((clue) => (
                  <div style={styles.clueCard}>
                    <div style={styles.clueWord}>
                      {clue.clue} ({clue.number})
                    </div>
                    <div style={styles.clueDetail}>
                      Connects: {clue.targetWords.join(", ")}
                    </div>
                    <div style={styles.clueDetail}>{clue.reasoning}</div>
                  </div>
                ))}
              </div>
            ))
          : null}
        <div style={styles.row}>
          <button type="button" style={styles.button} onClick={editBoard}>
            Edit board
          </button>
        </div>
      </div>
    );

    return {
      [NAME]: "Codenames Helper",
      [UI]: (
        <div style={styles.page}>
          <div style={styles.title}>Codenames Spymaster Helper</div>
          <div style={styles.row}>
            <span style={{ fontWeight: "500" }}>My team:</span>
            <button
              type="button"
              style={computed(() => teamButton("red", myTeam.get() === "red"))}
              onClick={chooseRed}
            >
              Red team
            </button>
            <button
              type="button"
              style={computed(() =>
                teamButton("blue", myTeam.get() === "blue")
              )}
              onClick={chooseBlue}
            >
              Blue team
            </button>
          </div>

          <div style={styles.grid}>
            {cardViews.map((card) =>
              isSetup
                ? (
                  // In setup the card holds its word's input, which cannot sit
                  // inside a button. Focusing the input (by Tab or a click)
                  // selects the card for coloring, so the keyboard reaches
                  // it too; a click on the card's edge selects it as well.
                  <div
                    style={card.style}
                    onClick={() => tapCard.send({ index: card.index })}
                  >
                    <cf-input
                      value={card.word}
                      placeholder={`${card.index + 1}`}
                      aria-label={`Card ${card.index + 1} word`}
                      timingStrategy="blur"
                      size="sm"
                      style={card.inputStyle}
                      oncf-focus={() => tapCard.send({ index: card.index })}
                      oncf-change={(e: { detail?: { value?: string } }) =>
                        setWord.send({
                          index: card.index,
                          word: e?.detail?.value ?? "",
                        })}
                    />
                  </div>
                )
                : (
                  <button
                    type="button"
                    aria-pressed={card.revealed}
                    style={card.style}
                    onClick={() => tapCard.send({ index: card.index })}
                  >
                    <span style={styles.wordLabel}>{card.label}</span>
                  </button>
                )
            )}
          </div>

          {isSetup ? setupPanel : playPanel}

          <div style={{ ...styles.row, paddingTop: "8px" }}>
            <button type="button" style={styles.danger} onClick={resetBoard}>
              New board
            </button>
          </div>
        </div>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title: "Codenames board" },
        content: fsContent,
      },
      board: cards,
      myTeam,
      mode,
      selectedIndex,
      inPlay,
      keyWarnings,
      clueRequest,
      tapCard,
      assignOwner,
      setWord,
      applyPhotoReading,
      clearColors,
      resetBoard,
      startPlay,
      editBoard,
      requestClues,
    };
  },
);

export default CodenamesHelper;

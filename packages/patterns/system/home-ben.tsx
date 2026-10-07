import {
  computed,
  equals,
  generateText,
  handler,
  hasError,
  isPending,
  NAME,
  pattern,
  resultOf,
  toCompactDebugString,
  UI,
  Writable,
} from "commonfabric";
import FavoritesManager from "./favorites-manager.tsx";
import Journal from "./journal.tsx";

// Types from favorites-manager.tsx and journal.tsx
type Favorite = {
  cell: { [NAME]?: string };
  // Discovery tags snapshotted from the piece's schema when favorited.
  tags: string[];
  userTags: string[];
  spaceName?: string;
};

type JournalSnapshot = {
  name?: string;
  schemaTag?: string;
  valueExcerpt?: string;
};

type JournalEntry = {
  timestamp?: number;
  eventType?: string;
  subject?: Writable<unknown>;
  snapshot?: JournalSnapshot;
  narrative?: string;
  narrativePending?: boolean;
  tags?: string[];
  space?: string;
};

type SpaceEntry = {
  name: string;
  did?: string;
};

/**
 * Capture a snapshot of a cell's current state for journaling.
 * Extracts name, schema tag, and a value excerpt.
 * Uses schema to properly resolve nested cell references.
 */
function captureSnapshot(
  cell: Writable<unknown>,
  schemaTag?: string,
): JournalSnapshot {
  let name = "";
  let valueExcerpt = "";

  try {
    const value = cell.get();
    if (value && typeof value === "object" && NAME in value) {
      const valueName = value[NAME];
      name = typeof valueName === "string" ? valueName : "";
    }
  } catch {
    // Ignore errors - name is optional
  }

  try {
    // Try to get the schema from the cell to properly resolve nested data
    let schemaCell = cell as any;
    try {
      const { schema } =
        schemaCell.asSchemaFromLinks?.()?.getAsNormalizedFullLink?.() || {};
      if (schema) {
        schemaCell = schemaCell.asSchema(schema);
      }
    } catch {
      // Ignore schema errors, fall back to direct get
    }

    const value = schemaCell.get();
    if (value !== undefined) {
      // Up to 2000 characters, to give the LLM context about the content.
      valueExcerpt = toCompactDebugString(value, { maxLength: 2000 });
    }
  } catch {
    // Ignore errors - excerpt is optional
  }

  return { name, schemaTag: schemaTag || "", valueExcerpt };
}

// Handler to add a favorite
const addFavorite = handler<
  { piece: Writable<{ [NAME]?: string }>; tags?: string[]; spaceName?: string },
  { favorites: Writable<Favorite[]>; journal: Writable<JournalEntry[]> }
>(({ piece, tags, spaceName }, { favorites, journal }) => {
  const current = favorites.get();
  if (!current.some((f) => f && equals(f.cell, piece))) {
    // Discovery tags are derived by the client and passed in; the handler
    // just stores them.
    const finalTags = tags ?? [];
    const hashTags = finalTags.map((t) => `#${t}`);

    favorites.push({
      cell: piece,
      tags: finalTags,
      userTags: [],
      spaceName,
    });

    // Add journal entry for the favorite action
    const snapshot = captureSnapshot(piece, hashTags.join(" "));
    journal.push({
      timestamp: Date.now(),
      eventType: "piece:favorited",
      subject: piece,
      snapshot,
      narrative: "",
      narrativePending: true,
      tags: hashTags,
      space: spaceName || "",
    });
  }
});

// Handler to remove a favorite
const removeFavorite = handler<
  { piece: Writable<unknown> },
  { favorites: Writable<Favorite[]>; journal: Writable<JournalEntry[]> }
>(({ piece }, { favorites, journal }) => {
  const favorite = favorites.get().find((f) => f && equals(f.cell, piece));
  if (favorite) {
    const hashTags = (favorite.tags ?? []).map((t) => `#${t}`);

    // Capture snapshot before removing
    const snapshot = captureSnapshot(piece, hashTags.join(" "));

    favorites.remove(favorite);

    // Add journal entry for the unfavorite action
    journal.push({
      timestamp: Date.now(),
      eventType: "piece:unfavorited",
      subject: piece,
      snapshot,
      narrative: "",
      narrativePending: true,
      tags: hashTags,
      space: favorite.spaceName || "",
    });
  }
});

// Handler to add a journal entry
const addJournalEntry = handler<
  { entry: JournalEntry },
  { journal: Writable<JournalEntry[]> }
>(({ entry }, { journal }) => {
  journal.push(entry);
});

// Handler to add a space to the managed list
const addSpaceHandler = handler<
  { detail: { message: string } },
  { spaces: Writable<SpaceEntry[]> }
>(({ detail }, { spaces }) => {
  const name = detail?.message?.trim();
  if (!name) return;
  const current = spaces.get();
  if (!current.some((s) => s.name === name)) {
    spaces.push({ name });
  }
});

// Handler to remove a space from the managed list
const removeSpaceHandler = handler<
  Record<string, never>,
  { name: string; spaces: Writable<SpaceEntry[]> }
>((_, { name, spaces }) => {
  const current = spaces.get();
  const filtered = current.filter((s) => s.name !== name);
  spaces.set(filtered);
});

export default pattern(() => {
  // OWN the data cells (.for for id stability)
  const favorites = new Writable<Favorite[]>([]).for("favorites");
  const journal = new Writable<JournalEntry[]>([]).for("journal");
  const spaces = new Writable<SpaceEntry[]>([]).for("spaces");
  const defaultAppUrl = new Writable("").for("defaultAppUrl");

  // Child components use wish() to access favorites/journal through defaultPattern
  const favoritesComponent = FavoritesManager({});
  const journalComponent = Journal({});
  const activeTab = new Writable("spaces").for("activeTab");

  // === REACTIVE NARRATIVE ENRICHMENT ===
  // LLM failures are explicit unavailable values. The writeback checks the
  // request with availability guards and marks entries as failed to prevent
  // retry loops.

  // Find the first pending entry that needs a narrative
  const pendingEntry = computed(() =>
    journal.get().find((e) => e.narrativePending && !e.narrative)
  );

  // Event type descriptions for narrative generation
  const eventDescriptions: Record<string, string> = {
    "piece:favorited": "favorited",
    "piece:unfavorited": "unfavorited",
    "piece:created": "created",
    "piece:modified": "modified",
    "space:entered": "entered a space",
  };

  // Generate narrative for pending entry
  // Uses context parameter to properly serialize cell content with schema
  const narrativeRequest = generateText({
    prompt: computed(() => {
      const entry = pendingEntry;
      if (!entry) return ""; // No-op when nothing pending
      const eventDesc = eventDescriptions[entry.eventType || ""] ||
        entry.eventType;

      return `Generate a brief journal entry (2-3 sentences) describing this user action.

Event: User ${eventDesc} a piece
Piece name: ${entry.snapshot?.name || "unnamed"}

The full content of the piece is available in the context below. IMPORTANT: Read and analyze the CONTENT, not just the title. If it's a note, what is it about? If it has data, what kind? Extract meaningful insights about their interests, work, or life from the actual content.

Write in past tense, personal style. Focus on:
1. What the content reveals about the user's interests/goals
2. Any specific topics, projects, or themes in the data
3. What this might indicate about what they care about`;
    }),
    system:
      "You analyze user activity and content to understand their interests. The piece content is provided in the context. Look at the actual data/content, not just titles. Extract meaningful insights about what they care about, work on, or are interested in.",
    // Pass the subject cell as context - system will serialize it properly
    context: computed(() => {
      const entry = pendingEntry;
      if (!entry?.subject) return {};
      return { favoritedPiece: entry.subject };
    }),
  });
  const narrative = resultOf(narrativeRequest);

  // Idempotent writeback - update entry when narrative is ready (or on error)
  const writeNarrative = computed(() => {
    const pending = isPending(narrativeRequest);
    const error = hasError(narrativeRequest);
    const entry = pendingEntry;

    // Guard: only proceed when not pending and we have an entry
    if (pending || !entry) return null;

    // Idempotent check: already written?
    if (entry.narrative !== "") return null;

    // Find the entry in the array
    const entries = journal.get();
    const idx = entries.findIndex((e) => e.timestamp === entry.timestamp);
    if (idx === -1) return null;

    // Handle error: mark as processed to prevent retry loop
    if (error) {
      const updatedEntry = {
        ...entries[idx],
        narrative: "[Failed to generate narrative]",
        narrativePending: false,
      };
      const newEntries = [...entries];
      newEntries[idx] = updatedEntry;
      journal.set(newEntries);
      return null;
    }

    // Guard: need a result to proceed
    if (!narrative) return null;

    // Create updated entry
    const updatedEntry = {
      ...entries[idx],
      narrative,
      narrativePending: false,
    };

    // Replace in array and set
    const newEntries = [...entries];
    newEntries[idx] = updatedEntry;
    journal.set(newEntries);

    return narrative;
  });

  // Reference writeNarrative to ensure it's evaluated (required for reactive side effects)
  void writeNarrative;

  return {
    [NAME]: `Home`,
    [UI]: (
      <cf-screen>
        <h1>
          home<strong>space</strong>
        </h1>

        <cf-tabs $value={activeTab}>
          <cf-tab-list>
            <cf-tab value="spaces">Spaces</cf-tab>
            <cf-tab value="journal">Journal</cf-tab>
            <cf-tab value="favorites">Favorites</cf-tab>
          </cf-tab-list>
          <cf-tab-panel value="journal">{journalComponent}</cf-tab-panel>
          <cf-tab-panel value="favorites">{favoritesComponent}</cf-tab-panel>
          <cf-tab-panel value="spaces">
            <cf-vstack gap="4" style={{ padding: "1rem" }}>
              <h2 style={{ margin: 0, fontSize: "16px" }}>My Spaces</h2>

              <cf-vstack gap="2">
                {spaces.map((space) => (
                  <cf-hstack gap="2" align="center">
                    <div style={{ flex: "1" }}>
                      <cf-space-link
                        spaceName={space.name}
                        spaceDid={space.did}
                      />
                    </div>
                    <cf-button
                      size="sm"
                      variant="ghost"
                      onClick={removeSpaceHandler({ name: space.name, spaces })}
                    >
                      ✕
                    </cf-button>
                  </cf-hstack>
                ))}
                {computed(() => spaces.get().length === 0)
                  ? (
                    <p
                      style={{
                        color: "#888",
                        fontStyle: "italic",
                        textAlign: "center",
                      }}
                    >
                      No spaces yet. Add one below.
                    </p>
                  )
                  : null}
              </cf-vstack>

              <hr style={{ border: "none", borderTop: "1px solid #e5e5e7" }} />

              <cf-vstack gap="1">
                <h3 style={{ margin: 0, fontSize: "14px" }}>
                  Add or Create Space
                </h3>
                <cf-message-input
                  placeholder="Space name..."
                  appearance="rounded"
                  oncf-send={addSpaceHandler({ spaces })}
                />
                <span style={{ fontSize: "11px", color: "#888" }}>
                  Type a name and press enter. Click the link to navigate.
                </span>
              </cf-vstack>

              <hr
                style={{
                  border: "none",
                  borderTop: "1px solid #e5e5e7",
                  margin: "8px 0",
                }}
              />

              <cf-vstack gap="1">
                <h3 style={{ margin: 0, fontSize: "14px" }}>Settings</h3>
                <label style={{ fontSize: "13px", color: "#666" }}>
                  Default App Pattern URL
                </label>
                <cf-input
                  $value={defaultAppUrl}
                  placeholder="/api/patterns/system/default-app.tsx"
                  style={{
                    width: "100%",
                    fontFamily: "monospace",
                    fontSize: "12px",
                  }}
                />
                <span style={{ fontSize: "11px", color: "#888" }}>
                  Pattern URL for new spaces. Leave empty for system default.
                </span>
              </cf-vstack>
            </cf-vstack>
          </cf-tab-panel>
        </cf-tabs>
      </cf-screen>
    ),

    // Exported data
    favorites,
    journal,
    spaces,
    defaultAppUrl,

    // Exported handlers (bound to state cells for external callers)
    addFavorite: addFavorite({ favorites, journal }),
    removeFavorite: removeFavorite({ favorites, journal }),
    addJournalEntry: addJournalEntry({ journal }),
  };
});

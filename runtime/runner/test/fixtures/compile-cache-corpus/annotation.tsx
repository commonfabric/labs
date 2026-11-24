// deno-lint-ignore-file no-explicit-any

/**
 * Annotation - A pattern for annotating existing cells/pieces.
 *
 * An annotation points at one or more existing cells (via targetPiece),
 * can reference other annotations it is "blocked by", and is discoverable
 * by agents via `wish({ query: "#annotation" })`.
 *
 * By including targetPiece in the `mentioned` output array, the annotated
 * piece automatically gains a backlink to this annotation — no special
 * wiring needed.
 *
 * Keywords: annotation, note, todo, wish, comment, blocker, backlink
 */
import {
  computed,
  type Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import type { MentionablePiece } from "./system/backlinks-index.tsx";

// ===== Types =====

export type AnnotationKind = "note" | "todo" | "wish";
export type AnnotationStatus =
  | "open"
  | "in-progress"
  | "resolved"
  | "dismissed";

export interface AnnotationPiece {
  [NAME]?: string;
  content?: string;
  kind?: AnnotationKind;
  status?: AnnotationStatus;
  targetPiece?: MentionablePiece | null;
  blockedBy?: AnnotationPiece[];
  isAnnotation?: boolean;
  isHidden?: boolean;
  mentioned?: MentionablePiece[];
}

export interface AnnotationInput {
  content: Writable<string | Default<"">>;
  kind: Writable<AnnotationKind | Default<"note">>;
  status: Writable<AnnotationStatus | Default<"open">>;
  targetPiece: Writable<MentionablePiece | null | Default<null>>;
  blockedBy: Writable<AnnotationPiece[] | Default<[]>>;
  isAnnotation: boolean | Default<true>;
  isHidden: boolean | Default<false>;
}

/** An #annotation pointing at an existing cell, optionally blocked by other annotations. */
export interface AnnotationOutput extends AnnotationPiece {
  [NAME]: string;
  [UI]: VNode;
  mentioned: MentionablePiece[];
  content: string;
  kind: AnnotationKind;
  status: AnnotationStatus;
  targetPiece: MentionablePiece | null;
  blockedBy: AnnotationPiece[];
  isAnnotation: boolean;
}

// ===== Handlers =====

const setKind = handler<Event, { kind: Writable<any> }>((event, { kind }) => {
  const val = (event.target as { value?: string })?.value;
  if (val) kind.set(val as AnnotationKind);
});

const setStatus = handler<Event, { status: Writable<any> }>(
  (event, { status }) => {
    const val = (event.target as { value?: string })?.value;
    if (val) status.set(val as AnnotationStatus);
  },
);

const markResolved = handler<unknown, { status: Writable<any> }>(
  (_event, { status }) => {
    status.set("resolved");
  },
);

const selectTarget = handler<
  unknown,
  {
    piece: MentionablePiece;
    targetPiece: Writable<any>;
    targetSearch: Writable<string>;
  }
>((_event, { piece, targetPiece, targetSearch }) => {
  targetPiece.set(piece);
  targetSearch.set("");
});

const clearTarget = handler<unknown, { targetPiece: Writable<any> }>(
  (_event, { targetPiece }) => {
    targetPiece.set(null);
  },
);

const addBlocker = handler<
  unknown,
  {
    blocker: AnnotationPiece;
    blockedBy: Writable<any>;
    blockerSearch: Writable<string>;
  }
>((_event, { blocker, blockedBy, blockerSearch }) => {
  const current = (blockedBy.get() ?? []) as AnnotationPiece[];
  if (!current.some((b) => b === blocker)) {
    blockedBy.set([...current, blocker]);
  }
  blockerSearch.set("");
});

const removeBlocker = handler<
  unknown,
  { index: number; blockedBy: Writable<any> }
>((_event, { index, blockedBy }) => {
  const current = (blockedBy.get() as AnnotationPiece[]) ?? [];
  blockedBy.set(current.toSpliced(index, 1));
});

const toggleBlockerPicker = handler<
  unknown,
  { showBlockerPicker: Writable<boolean> }
>((_event, { showBlockerPicker }) => {
  showBlockerPicker.set(!showBlockerPicker.get());
});

// ===== The Pattern =====

export const Annotation = pattern<AnnotationInput, AnnotationOutput>(
  ({ content, kind, status, targetPiece, blockedBy, isAnnotation }) => {
    // Local UI state
    const targetSearch = new Writable<string>("");
    const blockerSearch = new Writable<string>("");
    const showBlockerPicker = new Writable<boolean>(false);

    // Discover all mentionable pieces for target picker
    const mentionable = wish<MentionablePiece[]>({
      query: "#mentionable",
    }).result;

    // Discover other annotations for blocked-by picker
    const allAnnotations = wish<AnnotationPiece[]>({
      query: "#annotation",
    }).result;

    // Filtered mentionable list for target picker
    const filteredMentionable = computed(() => {
      const query = targetSearch.get().toLowerCase();
      const items = (mentionable ?? []).filter(
        (p) => !!p,
      ) as MentionablePiece[];
      if (!query) return items.slice(0, 10);
      return items
        .filter((p) => {
          const name = (p?.[NAME] ?? "").toLowerCase();
          return name.includes(query);
        })
        .slice(0, 10);
    });

    // Filtered annotations for blocker picker (exclude already-added ones)
    const filteredAnnotations = computed(() => {
      const query = blockerSearch.get().toLowerCase();
      const current = blockedBy.get() ?? [];
      const items = (allAnnotations ?? [])
        .filter((a) => !!a)
        .filter((a) => !current.some((b) => b === a)) as AnnotationPiece[];
      if (!query) return items.slice(0, 10);
      return items
        .filter((a) => {
          const name = (a?.[NAME] ?? "").toLowerCase();
          const c = (a?.content ?? "").toLowerCase();
          return name.includes(query) || c.includes(query);
        })
        .slice(0, 10);
    });

    // Derived state for UI
    const hasTarget = computed(() => targetPiece.get() != null);
    const isResolved = computed(
      () => status.get() === "resolved" || status.get() === "dismissed",
    );
    const kindValue = computed(() => kind.get() ?? "note");
    const statusValue = computed(() => status.get() ?? "open");
    const blockedByList = computed(() => blockedBy.get() ?? []);
    const targetPieceValue = computed(() => targetPiece.get());

    // The [NAME] for this annotation — emoji prefix + truncated content
    const annotationName = computed(() => {
      const k = kind.get() ?? "note";
      const c = (content.get() ?? "").trim();
      const prefix = k === "wish" ? "✨" : k === "todo" ? "☐" : "📌";
      const label = c ? c.slice(0, 40) : "New annotation";
      return `${prefix} ${label}`;
    });

    // The `mentioned` array feeds the backlinks system for free
    const mentioned = computed<MentionablePiece[]>(() => {
      const t = targetPiece.get();
      return t ? [t] : [];
    });

    return {
      [NAME]: annotationName,
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "12px" }}>
          {/* ── Header row: kind + status + resolve button ── */}
          <cf-hstack gap="2" style={{ alignItems: "center", flexWrap: "wrap" }}>
            {/* Kind selector */}
            <select
              style={{
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                padding: "4px 8px",
                fontSize: "13px",
                cursor: "pointer",
                background: "white",
              }}
              onChange={setKind({ kind: kind })}
            >
              <option value="note" selected={kindValue === "note"}>
                📌 Note
              </option>
              <option value="todo" selected={kindValue === "todo"}>
                ☐ Todo
              </option>
              <option value="wish" selected={kindValue === "wish"}>
                ✨ Wish
              </option>
            </select>

            {/* Status selector */}
            <select
              style={{
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                padding: "4px 8px",
                fontSize: "13px",
                cursor: "pointer",
                background: "white",
              }}
              onChange={setStatus({ status: status })}
            >
              <option value="open" selected={statusValue === "open"}>
                Open
              </option>
              <option
                value="in-progress"
                selected={statusValue === "in-progress"}
              >
                In Progress
              </option>
              <option value="resolved" selected={statusValue === "resolved"}>
                Resolved
              </option>
              <option value="dismissed" selected={statusValue === "dismissed"}>
                Dismissed
              </option>
            </select>

            {/* Mark resolved shortcut */}
            {ifElse(
              isResolved,
              <span
                style={{
                  fontSize: "12px",
                  color: "#6b7280",
                  fontStyle: "italic",
                }}
              >
                {statusValue}
              </span>,
              <cf-button
                onClick={markResolved({
                  status: status,
                })}
                style={{ fontSize: "12px" }}
              >
                Mark resolved
              </cf-button>,
            )}
          </cf-hstack>

          {/* ── Content textarea ── */}
          <cf-textarea
            $value={content}
            placeholder="Annotation content..."
            rows={4}
            style={{ width: "100%", fontSize: "14px" }}
          />

          {/* ── Target piece section ── */}
          <cf-vstack gap="2">
            <span
              style={{
                fontSize: "12px",
                fontWeight: "600",
                color: "#6b7280",
                textTransform: "uppercase",
              }}
            >
              Annotating
            </span>

            {ifElse(
              hasTarget,
              /* Target is set — show link + clear button */
              <cf-hstack gap="2" style={{ alignItems: "center" }}>
                <cf-cell-link $cell={targetPieceValue} />
                <cf-button
                  onClick={clearTarget({
                    targetPiece: targetPiece,
                  })}
                  style={{ fontSize: "12px" }}
                >
                  Remove
                </cf-button>
              </cf-hstack>,
              /* No target — show search picker */
              <cf-vstack gap="2">
                <cf-hstack gap="2">
                  <cf-input
                    $value={targetSearch}
                    placeholder="Search for a piece to annotate..."
                    style={{ flex: "1", fontSize: "13px" }}
                  />
                </cf-hstack>
                <cf-vstack
                  gap="1"
                  style={{
                    maxHeight: "160px",
                    overflowY: "auto",
                    border: "1px solid #e5e7eb",
                    borderRadius: "6px",
                  }}
                >
                  {filteredMentionable.map(
                    (piece: MentionablePiece) =>
                      piece && (
                        <button
                          type="button"
                          onClick={selectTarget({
                            piece,
                            targetPiece: targetPiece,
                            targetSearch,
                          })}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 10px",
                            fontSize: "13px",
                            background: "none",
                            border: "none",
                            borderBottom: "1px solid #f3f4f6",
                            cursor: "pointer",
                          }}
                        >
                          {piece?.[NAME] ?? "(unnamed)"}
                        </button>
                      ),
                  )}
                </cf-vstack>
              </cf-vstack>,
            )}
          </cf-vstack>

          {/* ── Blocked by section ── */}
          <cf-vstack gap="2">
            <span
              style={{
                fontSize: "12px",
                fontWeight: "600",
                color: "#6b7280",
                textTransform: "uppercase",
              }}
            >
              Blocked by
            </span>

            {/* Current blockers */}
            <cf-vstack gap="1">
              {blockedByList.map((blocker: AnnotationPiece, index: number) => (
                <cf-hstack key={index} gap="2" style={{ alignItems: "center" }}>
                  <cf-cell-link $cell={blocker} />
                  <cf-button
                    onClick={removeBlocker({
                      index,
                      blockedBy: blockedBy,
                    })}
                    style={{ fontSize: "11px" }}
                  >
                    Remove
                  </cf-button>
                </cf-hstack>
              ))}
            </cf-vstack>

            {/* Add blocker toggle */}
            <cf-button
              onClick={toggleBlockerPicker({ showBlockerPicker })}
              style={{ fontSize: "12px", alignSelf: "flex-start" }}
            >
              + Add blocker
            </cf-button>

            {/* Blocker search picker */}
            {ifElse(
              showBlockerPicker,
              <cf-vstack gap="2">
                <cf-input
                  $value={blockerSearch}
                  placeholder="Search annotations..."
                  style={{ fontSize: "13px" }}
                />
                <cf-vstack
                  gap="1"
                  style={{
                    maxHeight: "160px",
                    overflowY: "auto",
                    border: "1px solid #e5e7eb",
                    borderRadius: "6px",
                  }}
                >
                  {filteredAnnotations.map(
                    (ann: AnnotationPiece) =>
                      ann && (
                        <button
                          type="button"
                          onClick={addBlocker({
                            blocker: ann,
                            blockedBy: blockedBy,
                            blockerSearch,
                          })}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 10px",
                            fontSize: "13px",
                            background: "none",
                            border: "none",
                            borderBottom: "1px solid #f3f4f6",
                            cursor: "pointer",
                          }}
                        >
                          {ann?.[NAME] ?? ann?.content ?? "(unnamed)"}
                        </button>
                      ),
                  )}
                </cf-vstack>
              </cf-vstack>,
              <span />,
            )}
          </cf-vstack>
        </cf-vstack>
      ),
      mentioned,
      content,
      kind,
      status,
      targetPiece,
      blockedBy,
      isAnnotation,
    };
  },
);

export default Annotation;

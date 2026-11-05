/**
 * Annotation Manager — lists all annotations in the space, grouped by status.
 *
 * Wishes for #annotation to collect every annotation piece, then renders
 * them with quick-action resolve/dismiss buttons and links to both the
 * annotation itself and the piece it targets.
 *
 * Keywords: annotation, manager, todo, wish, overview, agent, graph
 */
import {
  computed,
  handler,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commonfabric";
import type {
  AnnotationKind,
  AnnotationPiece,
  AnnotationStatus,
} from "./annotation.tsx";

// ===== Handlers =====

const resolveAnnotation = handler<
  unknown,
  { status: Writable<AnnotationStatus> }
>((_event, { status }) => {
  status.set("resolved");
});

const dismissAnnotation = handler<
  unknown,
  { status: Writable<AnnotationStatus> }
>((_event, { status }) => {
  status.set("dismissed");
});

const reopenAnnotation = handler<
  unknown,
  { status: Writable<AnnotationStatus> }
>((_event, { status }) => {
  status.set("open");
});

const setFilter = handler<unknown, { filter: Writable<string>; value: string }>(
  (_event, { filter, value }) => {
    filter.set(value);
  },
);

// ===== Helpers =====

const KIND_ICON: Record<AnnotationKind, string> = {
  note: "📌",
  todo: "☐",
  wish: "✨",
};

const STATUS_STYLE: Record<AnnotationStatus, string> = {
  open: "background:#dbeafe;color:#1d4ed8",
  "in-progress": "background:#fef9c3;color:#854d0e",
  resolved: "background:#dcfce7;color:#166534",
  dismissed: "background:#f3f4f6;color:#6b7280",
};

// ===== The Pattern =====

export default pattern<Record<string, never>>((_) => {
  const filter = new Writable<string>("open");

  const { candidates: annotations } = wish<AnnotationPiece>({
    query: "#annotation",
    scope: [".", "~"],
  });

  const filtered = computed(() => {
    const f = filter.get();
    const all = (annotations ?? []).filter((a) => !!a) as AnnotationPiece[];
    if (f === "all") return all;
    return all.filter((a) => (a?.status ?? "open") === f);
  });

  const counts = computed(() => {
    const all = (annotations ?? []).filter((a) => !!a) as AnnotationPiece[];
    return {
      all: all.length,
      open: all.filter((a) => (a?.status ?? "open") === "open").length,
      "in-progress": all.filter((a) => a?.status === "in-progress").length,
      resolved: all.filter((a) => a?.status === "resolved").length,
      dismissed: all.filter((a) => a?.status === "dismissed").length,
    };
  });

  const filterValue = computed(() => filter.get());

  const TAB_LABELS: Array<{ key: string; label: string }> = [
    { key: "open", label: "Open" },
    { key: "in-progress", label: "In progress" },
    { key: "resolved", label: "Resolved" },
    { key: "dismissed", label: "Dismissed" },
    { key: "all", label: "All" },
  ];

  return {
    [NAME]: computed(() => {
      const openCount = counts.open ?? 0;
      return `🗂 Annotations (${openCount} open)`;
    }),
    [UI]: (
      <cf-vstack gap="3" style={{ padding: "16px" }}>
        {/* ── Filter tabs ── */}
        <cf-hstack gap="1" style={{ flexWrap: "wrap" }}>
          {TAB_LABELS.map(({ key, label }) => (
            <button
              type="button"
              onClick={setFilter({ filter, value: key })}
              style={{
                padding: "4px 10px",
                borderRadius: "16px",
                border: "1px solid #d1d5db",
                fontSize: "12px",
                cursor: "pointer",
                fontWeight: filterValue === key ? "600" : "400",
                background: filterValue === key ? "#1d4ed8" : "white",
                color: filterValue === key ? "white" : "#374151",
              }}
            >
              {label} ({counts[key as keyof typeof counts] ?? 0})
            </button>
          ))}
        </cf-hstack>

        {/* ── Annotation list ── */}
        <cf-vstack gap="2">
          {filtered.map(
            (ann: AnnotationPiece) =>
              ann && (
                <cf-vstack
                  gap="1"
                  style={{
                    padding: "10px 12px",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    background: "white",
                  }}
                >
                  {/* Row 1: kind icon + link to annotation + status badge */}
                  <cf-hstack gap="2" style={{ alignItems: "center" }}>
                    <span style={{ fontSize: "14px" }}>
                      {KIND_ICON[ann?.kind ?? "note"] ?? "📌"}
                    </span>
                    <cf-cell-link $cell={ann} />
                    <span
                      style={{
                        fontSize: "11px",
                        padding: "2px 6px",
                        borderRadius: "10px",
                        ...(STATUS_STYLE[ann?.status ?? "open"]
                          ? Object.fromEntries(
                            STATUS_STYLE[ann?.status ?? "open"]
                              .split(";")
                              .filter(Boolean)
                              .map((s) => s.split(":").map((p) => p.trim())),
                          )
                          : {}),
                      }}
                    >
                      {ann?.status ?? "open"}
                    </span>
                  </cf-hstack>

                  {/* Row 2: target piece link (if set) */}
                  {ann?.targetPiece && (
                    <cf-hstack gap="1" style={{ alignItems: "center" }}>
                      <span style={{ fontSize: "11px", color: "#9ca3af" }}>
                        on:
                      </span>
                      <cf-cell-link $cell={ann.targetPiece} />
                    </cf-hstack>
                  )}

                  {/* Row 3: action buttons */}
                  <cf-hstack gap="1" style={{ marginTop: "4px" }}>
                    {(ann?.status === "open" ||
                      ann?.status === "in-progress") && (
                      <cf-button
                        size="sm"
                        onClick={resolveAnnotation({ status: ann.status! })}
                      >
                        Resolve
                      </cf-button>
                    )}
                    {(ann?.status === "open" ||
                      ann?.status === "in-progress") && (
                      <cf-button
                        size="sm"
                        variant="secondary"
                        onClick={dismissAnnotation({ status: ann.status! })}
                      >
                        Dismiss
                      </cf-button>
                    )}
                    {(ann?.status === "resolved" ||
                      ann?.status === "dismissed") && (
                      <cf-button
                        size="sm"
                        variant="secondary"
                        onClick={reopenAnnotation({ status: ann.status! })}
                      >
                        Reopen
                      </cf-button>
                    )}
                  </cf-hstack>
                </cf-vstack>
              ),
          )}
          {filtered.length === 0 && (
            <span style={{ color: "#9ca3af", fontSize: "14px" }}>
              No {filterValue === "all" ? "" : filterValue} annotations.
            </span>
          )}
        </cf-vstack>
      </cf-vstack>
    ),
  };
});

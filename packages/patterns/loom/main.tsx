/** A space default pattern whose ordered panel occurrences own composition. */
import { computed, handler, NAME, pattern, UI, Writable } from "commonfabric";
import type {
  LoomInput,
  LoomOutput,
  Panel,
  PanelPosition,
  Presentation,
  ViewerState,
} from "./schemas.tsx";

type State = {
  panels: Writable<Writable<Panel>[]>;
  presentation: Writable<Presentation>;
};

/** Locate an insertion anchor in the transaction's current collection. */
function insertionIndex(
  list: readonly Writable<Panel>[],
  before?: Writable<Panel>,
): number {
  if (before === undefined) return list.length;
  const index = list.findIndex((panel) => panel.equals(before));
  if (index < 0) {
    throw new Error("The insertion anchor is no longer in this Loom");
  }
  return index;
}

/** Return an absolute HTTP(S) URL that contains no embedded credentials. */
function externalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" || url.password !== ""
    ) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Validate a URL before admitting its occurrence to the shared composition. */
function validatePanel(panel: Panel): void {
  if (panel.kind === "url" && externalUrl(panel.url) === undefined) {
    throw new Error("A URL panel requires an HTTP(S) URL without credentials");
  }
}

/** Compare piece membership by complete link identity, including scope and space. */
function containsPiece(
  list: readonly Writable<Panel>[],
  piece: Writable<unknown>,
): boolean {
  return list.some((panel) => {
    const value = panel.get();
    return value.kind === "piece" && value.piece.equalLinks(piece);
  });
}

const addPiece = handler<{ piece: Writable<unknown> }, State>(
  ({ piece }, { panels }) => {
    const list = panels.get();
    if (containsPiece(list, piece)) return;
    const panel = new Writable<Panel>();
    panel.set({ kind: "piece", piece });
    panels.set([...list, panel]);
  },
);

/** Return occurrences whose target differs from the complete piece link. */
function withoutPiece(
  list: readonly Writable<Panel>[],
  piece: Writable<unknown>,
): Writable<Panel>[] {
  return list.filter((panel) => {
    const value = panel.get();
    return value.kind !== "piece" || !value.piece.equalLinks(piece);
  });
}

const removePiece = handler<{ piece: Writable<unknown> }, State>(
  ({ piece }, { panels, presentation }) => {
    const next = withoutPiece(panels.get(), piece);
    panels.set(next);
    const current = presentation.get();
    presentation.set({
      stagedPanels: current.stagedPanels.filter((panel) =>
        next.some((member) => member.equals(panel))
      ),
      ...(current.focusedPanel &&
          next.some((member) => member.equals(current.focusedPanel!))
        ? { focusedPanel: current.focusedPanel }
        : {}),
    });
  },
);

const addPanel = handler<PanelPosition, State>(
  ({ panel, before }, { panels }) => {
    const list = panels.get();
    const index = insertionIndex(list, before);
    if (list.some((existing) => existing.equals(panel))) return;
    validatePanel(panel.get());
    const next = [...list];
    next.splice(index, 0, panel);
    panels.set(next);
  },
);

const removePanel = handler<{ panel: Writable<Panel> }, State>(
  ({ panel }, { panels, presentation }) => {
    const list = panels.get();
    panels.set(list.filter((existing) => !existing.equals(panel)));
    const current = presentation.get();
    presentation.set({
      stagedPanels: current.stagedPanels.filter((existing) =>
        !existing.equals(panel)
      ),
      ...(current.focusedPanel && !current.focusedPanel.equals(panel)
        ? { focusedPanel: current.focusedPanel }
        : {}),
    });
  },
);

const movePanel = handler<PanelPosition, State>(
  ({ panel, before }, { panels }) => {
    const list = panels.get();
    if (!list.some((existing) => existing.equals(panel))) {
      throw new Error("The panel is no longer in this Loom");
    }
    insertionIndex(list, before);
    if (before?.equals(panel)) return;
    const next = list.filter((existing) => !existing.equals(panel));
    next.splice(insertionIndex(next, before), 0, panel);
    panels.set(next);
  },
);

const duplicatePanel = handler<PanelPosition, State>(
  ({ panel, before }, { panels }) => {
    const list = panels.get();
    if (!list.some((existing) => existing.equals(panel))) {
      throw new Error("The panel is no longer in this Loom");
    }
    const index = insertionIndex(list, before);
    const source = panel.get();
    validatePanel(source);
    // The handler invocation supplies the cause, so replay addresses this same occurrence.
    const occurrence = new Writable<Panel>();
    const title = source.titleOverride === undefined
      ? {}
      : { titleOverride: source.titleOverride };
    if (source.kind === "piece") {
      occurrence.set({ kind: "piece", piece: source.piece, ...title });
    } else if (source.kind === "document") {
      occurrence.set({ kind: "document", content: source.content, ...title });
    } else occurrence.set({ kind: "url", url: source.url, ...title });
    const next = [...list];
    next.splice(index, 0, occurrence);
    panels.set(next);
  },
);

const setPresentation = handler<Presentation, State>(
  (event, { panels, presentation }) => {
    const list = panels.get();
    const staged = event.stagedPanels;
    for (let i = 0; i < staged.length; i++) {
      if (!list.some((panel) => panel.equals(staged[i]))) {
        throw new Error("A staged panel is no longer in this Loom");
      }
      if (staged.slice(0, i).some((panel) => panel.equals(staged[i]))) {
        throw new Error("Staged panels must be unique");
      }
    }
    if (
      event.focusedPanel &&
      !staged.some((panel) => panel.equals(event.focusedPanel!))
    ) {
      throw new Error("The focused panel must be staged");
    }
    presentation.set({
      stagedPanels: staged,
      ...(event.focusedPanel ? { focusedPanel: event.focusedPanel } : {}),
    });
  },
);

/** Present one linked occurrence without reading a piece's protected fields. */
export const PanelView = pattern<{ panel: Writable<Panel> }>(({ panel }) => ({
  [UI]: computed(() => {
    const value = panel.get();
    if (value.kind === "piece") {
      return (
        <cf-vstack gap="2">
          {value.titleOverride ? <h3>{value.titleOverride}</h3> : null}
          <cf-cell-link $cell={value.piece}>Open piece</cf-cell-link>
          <cf-render $cell={value.piece} />
        </cf-vstack>
      );
    }
    if (value.kind === "url") {
      const url = externalUrl(value.url);
      if (url === undefined) {
        return <p>This panel requires an HTTP(S) URL without credentials.</p>;
      }
      return (
        <cf-vstack gap="2">
          <h3>{value.titleOverride || url}</h3>
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open in new tab
          </a>
          <p>If this page cannot be embedded, open it in a new tab.</p>
          <iframe
            src={url}
            title={value.titleOverride || "External page"}
            sandbox="allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
            style={{ width: "100%", height: "360px", border: "0" }}
          />
        </cf-vstack>
      );
    }
    const document = value.content.get()?.source;
    if (document === undefined) {
      return <p>This document is unavailable.</p>;
    }
    if (document.kind === "page-excerpt") {
      return (
        <cf-vstack gap="2">
          <h3>{value.titleOverride || document.title}</h3>
          <div style={{ whiteSpace: "pre-wrap" }}>{document.body}</div>
          <cf-textarea
            $value={value.content.key("notes")}
            placeholder="Shared notes"
          />
        </cf-vstack>
      );
    }
    return (
      <cf-vstack gap="2">
        <h3>{value.titleOverride || document.name}</h3>
        {document.photo
          ? <img src={document.photo} alt="" style={{ maxWidth: "96px" }} />
          : null}
        {document.channels.map((channel) => (
          <div>{channel.label || channel.kind}: {channel.value}</div>
        ))}
        <cf-textarea
          $value={value.content.key("notes")}
          placeholder="Shared notes"
        />
      </cf-vstack>
    );
  }),
}));

const selectPanel = handler<
  void,
  { panel: Writable<Panel>; viewerState: Writable<ViewerState> }
>((_, { panel, viewerState }) => {
  viewerState.set({ selectedPanel: panel });
});

export default pattern<LoomInput, LoomOutput>(
  ({ title, panels, presentation }) => {
    const pieceRegistry = computed(() =>
      panels.get().flatMap((panel) => {
        const value = panel.get();
        return value.kind === "piece" ? [value.piece] : [];
      })
    );
    const state = { panels, presentation };
    const viewerState = new Writable.perSession<ViewerState>({});
    const remove = removePanel(state);
    const move = movePanel(state);
    const duplicate = duplicatePanel(state);
    const present = setPresentation(state);
    return {
      [NAME]: title,
      [UI]: (
        <cf-theme>
          <cf-screen>
            <cf-toolbar slot="header">
              <h1 slot="start">{title}</h1>
              <cf-hstack slot="end" gap="2" wrap>
                <cf-button
                  onClick={() =>
                    present.send({ stagedPanels: [...panels.get()] })}
                >
                  Stage all
                </cf-button>
                <cf-button onClick={() => present.send({ stagedPanels: [] })}>
                  Clear stage
                </cf-button>
                <cf-button
                  onClick={() =>
                    present.send({
                      stagedPanels: [...presentation.get().stagedPanels],
                    })}
                >
                  Clear focus
                </cf-button>
              </cf-hstack>
            </cf-toolbar>
            <cf-vscroll>
              <cf-vstack gap="4" padding="4">
                {panels.map((panel) => (
                  <cf-card>
                    <cf-hstack gap="2" wrap>
                      <cf-button onClick={selectPanel({ panel, viewerState })}>
                        {viewerState.key("selectedPanel").equals(panel)
                          ? "Selected in this session"
                          : "Select"}
                      </cf-button>
                      <cf-button onClick={() => duplicate.send({ panel })}>
                        Duplicate
                      </cf-button>
                      <cf-button onClick={() => remove.send({ panel })}>
                        Remove
                      </cf-button>
                      <cf-button
                        onClick={() =>
                          move.send({ panel, before: panels.get()[0] })}
                      >
                        Move first
                      </cf-button>
                      <cf-button onClick={() => move.send({ panel })}>
                        Move last
                      </cf-button>
                      <cf-button
                        disabled={!presentation.get().stagedPanels.some((
                          member,
                        ) => member.equals(panel))}
                        onClick={() =>
                          present.send({
                            stagedPanels: [...presentation.get().stagedPanels],
                            focusedPanel: panel,
                          })}
                      >
                        {presentation.get().focusedPanel?.equals(panel)
                          ? "Focused for everyone"
                          : "Focus"}
                      </cf-button>
                      <span>
                        {presentation.get().stagedPanels.some((member) =>
                            member.equals(panel)
                          )
                          ? "Staged for everyone"
                          : "Not staged"}
                      </span>
                    </cf-hstack>
                    <cf-render $cell={PanelView({ panel })} />
                  </cf-card>
                ))}
              </cf-vstack>
            </cf-vscroll>
          </cf-screen>
        </cf-theme>
      ),
      title,
      panels,
      presentation,
      pieceRegistry,
      viewerState,
      addPiece: addPiece(state),
      removePiece: removePiece(state),
      addPanel: addPanel(state),
      removePanel: remove,
      movePanel: move,
      duplicatePanel: duplicate,
      setPresentation: present,
    };
  },
);

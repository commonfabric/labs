/** A space default pattern whose ordered panel occurrences own composition. */
import {
  computed,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import { admitPanel, externalUrl, insertionIndex } from "./admission.tsx";
import type {
  LoomInput,
  LoomOutput,
  Panel,
  PanelAdmission,
  PanelPosition,
  ParticipantProfile,
  Presentation,
  ViewerState,
} from "./schemas.tsx";
import { addParticipant, participantEntries } from "./participants.tsx";

type State = {
  panels: Writable<Writable<Panel>[]>;
  presentation: Writable<Presentation>;
};

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
function renderPanel(panel: Writable<Panel>) {
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
}

/** Standalone view of one linked panel occurrence. */
export const PanelView = pattern<{ panel: Writable<Panel> }, { [UI]: VNode }>((
  { panel },
) => ({
  [UI]: computed(() => renderPanel(panel)),
}));

/**
 * The profile `cell` resolves to, or `undefined` when it holds none. A bound
 * profile that has not resolved is an empty cell rather than `undefined`, and
 * linking it would record no profile at all.
 */
function resolvedProfile(
  cell: ParticipantProfile | undefined,
): ParticipantProfile | undefined {
  const target = cell?.resolveAsCell();
  return target === undefined || target.get() === undefined
    ? undefined
    : target;
}

/**
 * Duplicates `panel` under the profile this session acts as: the one it
 * claimed in `viewerState`, or else the viewer's `#profile`. With neither, the
 * copy is attributed to the Loom's owner.
 */
const duplicateAsViewer = handler<
  void,
  {
    panel: Writable<Panel>;
    duplicate: Stream<PanelAdmission>;
    claimed: ParticipantProfile | undefined;
    wished: ParticipantProfile | undefined;
  }
>((_, { panel, duplicate, claimed, wished }) => {
  const profile = resolvedProfile(claimed) ?? resolvedProfile(wished);
  duplicate.send({ panel, ...(profile === undefined ? {} : { as: profile }) });
});

const selectPanel = handler<
  void,
  { panel: Writable<Panel>; viewerState: Writable<ViewerState> }
>((_, { panel, viewerState }) => {
  viewerState.key("selectedPanel").set(panel);
});

export default pattern<LoomInput, LoomOutput>(
  ({ title, panels, presentation, participants }) => {
    const pieceRegistry = computed(() =>
      panels.get().flatMap((panel) => {
        const value = panel.get();
        return value.kind === "piece" ? [value.piece] : [];
      })
    );
    const roster = computed(() => participantEntries(participants));
    const state = { panels, presentation };
    const viewerState = new Writable.perSession<ViewerState>({});
    const remove = removePanel(state);
    const move = movePanel(state);
    const duplicate = admitPanel({ panels, mode: "duplicate" });
    const viewerProfile = wish<ParticipantProfile>({ query: "#profile" });
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
                      <cf-button
                        onClick={duplicateAsViewer({
                          panel,
                          duplicate,
                          claimed: viewerState.key("actingProfile"),
                          wished: viewerProfile.result,
                        })}
                      >
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
                    {/* Stateless panel views need no durable child setup by READ viewers. */}
                    {computed(() => renderPanel(panel))}
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
      addPiece: admitPanel({ panels, mode: "piece" }),
      removePiece: removePiece(state),
      addPanel: admitPanel({ panels, mode: "panel" }),
      removePanel: remove,
      movePanel: move,
      duplicatePanel: duplicate,
      setPresentation: present,
      participants: roster,
      addParticipant: addParticipant({ roster: participants }),
    };
  },
);

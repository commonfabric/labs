/** A space default pattern whose ordered panel occurrences own composition. */
import {
  computed,
  handler,
  ifElse,
  NAME,
  pattern,
  spaceOf,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  admitPanel,
  assertRemovable,
  externalUrl,
  insertionIndex,
  validatePanel,
} from "./admission.tsx";
import type {
  ChatRoomCell,
  ChatRoomChoice,
  LoomInput,
  LoomOutput,
  Panel,
  PanelAdmission,
  PanelPosition,
  PanelRetarget,
  PanelTitle,
  ParticipantProfile,
  Presentation,
  PrivatePanel,
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

/** Throws unless `panel` is one of the occurrences in `list`. */
function assertInLoom(
  list: readonly Writable<Panel>[],
  panel: Writable<Panel>,
): void {
  if (!list.some((existing) => existing.equals(panel))) {
    throw new Error("The panel is no longer in this Loom");
  }
}

/**
 * Whether `hidden`, the occurrences a viewer has hidden, holds `panel`. A
 * viewer who has never hidden a panel may read no list at all, which hides
 * nothing.
 */
function isHidden(
  hidden: readonly Writable<Panel>[] | undefined,
  panel: Writable<Panel>,
): boolean {
  return (hidden ?? []).some((entry) => entry.equals(panel));
}

/**
 * Whether `entry` holds `panel`. The handlers below compare private entries
 * only through this helper: a handler's state schema is inferred from the uses
 * its body shows, and an entry's panel compared with `equals` in the body
 * itself reads as `undefined` there.
 */
function holdsPanel(entry: PrivatePanel, panel: Writable<Panel>): boolean {
  return entry.panel.equals(panel);
}

/** The shared panels one viewer has not hidden, in the shared order. */
function shownPanels(
  shared: readonly Writable<Panel>[],
  hidden: readonly Writable<Panel>[] | undefined,
): Writable<Panel>[] {
  return shared.filter((panel) => !isHidden(hidden, panel));
}

/**
 * The private panels anchored to `panel`, which a viewer is shown just ahead
 * of it while it is shown, in the order of the private list.
 */
function privatePanelsBefore(
  privates: readonly PrivatePanel[] | undefined,
  panel: Writable<Panel>,
): Writable<Panel>[] {
  return (privates ?? [])
    .filter((entry) => entry.before?.equals(panel) === true)
    .map((entry) => entry.panel);
}

/**
 * The private panels a viewer is shown after every shared one: those anchored
 * to none of the panels in `shown`, in the order of the private list.
 */
function trailingPrivatePanels(
  shown: readonly Writable<Panel>[],
  privates: readonly PrivatePanel[] | undefined,
): Writable<Panel>[] {
  return (privates ?? [])
    .filter((entry) =>
      !shown.some((panel) => entry.before?.equals(panel) === true)
    )
    .map((entry) => entry.panel);
}

/**
 * The panels one viewer is shown: the shared ones they have not hidden, in the
 * shared order, with each of their private panels just ahead of the shared one
 * it is anchored to, or after all of them while that one is not shown. Private
 * panels anchored alike keep the order of the private list.
 */
function viewerList(
  shared: readonly Writable<Panel>[],
  hidden: readonly Writable<Panel>[] | undefined,
  privates: readonly PrivatePanel[] | undefined,
): Writable<Panel>[] {
  const shown = shownPanels(shared, hidden);
  return [
    ...shown.flatMap((
      panel,
    ) => [...privatePanelsBefore(privates, panel), panel]),
    ...trailingPrivatePanels(shown, privates),
  ];
}

const removePiece = handler<{ piece: Writable<unknown> }, State>(
  ({ piece }, { panels, presentation }) => {
    const list = panels.get();
    const next = withoutPiece(list, piece);
    // Every occurrence of the piece goes or none does: one that another
    // principal added refuses the whole unregistration.
    for (const panel of list) {
      if (!next.some((kept) => kept.equals(panel))) {
        assertRemovable(panel, panels);
      }
    }
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
    if (list.some((existing) => existing.equals(panel))) {
      assertRemovable(panel, panels);
    }
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
    assertInLoom(list, panel);
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

/**
 * Names `room` as the Loom's chat room, or clears it when the event names
 * none; no other handler of the root changes it. The room must live in the
 * Loom's own space, so that its members, the principals its space's access
 * list admits, are the Loom's. The designation is independent of the panels:
 * it persists while no panel shows the room, and a reader that needs to know
 * whether one does looks for the room among the piece panels.
 *
 * @throws When `room` lives in another space.
 */
const setChatRoom = handler<ChatRoomChoice, { chatRoom: ChatRoomCell }>(
  ({ room }, { chatRoom }) => {
    // `chatRoom` holds a record rather than a link, so its space is the
    // Loom's.
    if (room !== undefined && spaceOf(room) !== spaceOf(chatRoom)) {
      throw new Error("The chat room must be in this Loom's space");
    }
    chatRoom.set(room === undefined ? {} : { room });
  },
);

/** Sets the Loom's title, which is also its name. */
const retitleLoom = handler<{ title: string }, { title: Writable<string> }>(
  (event, { title }) => {
    title.set(event.title);
  },
);

/**
 * Sets the title `panel` shows in place of its target's; an empty title
 * clears it, leaving no override for a copy of the panel to carry. Only
 * `titleOverride` is written, so the panel's target and its adder, with the
 * label the root stamped there, stay as they were. Any member may retitle any
 * panel: only removal turns on who added it.
 *
 * @throws When `panel` is not in this Loom.
 */
const retitlePanel = handler<
  PanelTitle,
  { panels: Writable<Writable<Panel>[]> }
>(({ panel, titleOverride }, { panels }) => {
  assertInLoom(panels.get(), panel);
  panel.key("titleOverride").set(
    titleOverride === "" ? undefined : titleOverride,
  );
});

/**
 * Points a URL or piece panel at `target` in place, so the occurrence keeps
 * its place in the list, its staging and focus, its title and its adder. Only
 * `kind` and the target's key are written, and a change of kind removes the
 * other kind's key: a write of the whole panel would carry the adder's fields,
 * which only `admitPanel` may write. The target the panel leaves is untouched.
 *
 * @throws When `panel` is not in this Loom, when it is a document, whose
 * content is its producer's, or when `target` names a URL a panel may not hold.
 */
const retargetPanel = handler<
  PanelRetarget,
  { panels: Writable<Writable<Panel>[]> }
>(({ panel, target }, { panels }) => {
  assertInLoom(panels.get(), panel);
  const kind = panel.get().kind;
  if (kind === "document") {
    throw new Error("A document panel shows its producer's content");
  }
  if (target.kind === "url" && externalUrl(target.url) === undefined) {
    throw new Error("A URL panel requires an HTTP(S) URL without credentials");
  }
  if (kind !== target.kind) {
    panel.update(kind === "url" ? { url: undefined } : { piece: undefined });
  }
  if (target.kind === "url") panel.update({ kind: "url", url: target.url });
  else panel.update({ kind: "piece", piece: target.piece });
});

/**
 * Hides `panel` from the acting principal's own view of the Loom, in every
 * session of theirs, and from nobody else's; the shared list keeps it.
 * Hiding a panel already hidden changes nothing.
 *
 * @throws When `panel` is not in this Loom.
 */
const hidePanel = handler<
  { panel: Writable<Panel> },
  {
    panels: Writable<Writable<Panel>[]>;
    hiddenPanels: Writable<Writable<Panel>[]>;
  }
>(({ panel }, { panels, hiddenPanels }) => {
  assertInLoom(panels.get(), panel);
  hiddenPanels.addUnique(panel);
});

/**
 * Adds `panel` to the acting principal's private panels, which nobody else is
 * shown, just ahead of `before` among the shared ones, or after all of them.
 * The occurrence must live in a space other than the Loom's: every member may
 * read what the Loom's space holds, so a private panel is private by the access
 * list of the space it lives in. Adding one already among them changes
 * nothing.
 *
 * @throws When `panel` lives in the Loom's space, when it is a URL panel whose
 * URL a panel may not hold, or when `before` is not in this Loom.
 */
const addPrivatePanel = handler<
  PanelPosition,
  {
    panels: Writable<Writable<Panel>[]>;
    privatePanels: Writable<PrivatePanel[]>;
  }
>(({ panel, before }, { panels, privatePanels }) => {
  if (spaceOf(panel) === spaceOf(panels)) {
    throw new Error("A private panel must live outside the Loom's space");
  }
  validatePanel(panel.get());
  insertionIndex(panels.get(), before);
  const list = privatePanels.get() ?? [];
  if (list.some((entry) => holdsPanel(entry, panel))) return;
  privatePanels.set([
    ...list,
    before === undefined ? { panel } : { panel, before },
  ]);
});

/**
 * Takes `panel` off the acting principal's private panels. The occurrence
 * itself, in its own space, is left as it is.
 */
const removePrivatePanel = handler<
  { panel: Writable<Panel> },
  { privatePanels: Writable<PrivatePanel[]> }
>(({ panel }, { privatePanels }) => {
  const list = privatePanels.get() ?? [];
  const next = list.filter((entry) => !holdsPanel(entry, panel));
  if (next.length !== list.length) privatePanels.set(next);
});

/**
 * Moves one of the acting principal's private panels to show just ahead of
 * `before`: a shared occurrence, or another of their private panels, whose
 * anchor it then takes. Without `before`, it shows after every shared panel,
 * last among the private panels shown there.
 *
 * @throws When `panel` is not one of the acting principal's private panels, or
 * when `before` is neither in this Loom nor one of them.
 */
const movePrivatePanel = handler<
  PanelPosition,
  {
    panels: Writable<Writable<Panel>[]>;
    privatePanels: Writable<PrivatePanel[]>;
  }
>(({ panel, before }, { panels, privatePanels }) => {
  const list = privatePanels.get() ?? [];
  if (!list.some((entry) => holdsPanel(entry, panel))) {
    throw new Error("The panel is not one of your private panels");
  }
  const rest = list.filter((entry) => !holdsPanel(entry, panel));
  if (before === undefined) {
    privatePanels.set([...rest, { panel }]);
    return;
  }
  if (panels.get().some((shared) => shared.equals(before))) {
    privatePanels.set([...rest, { panel, before }]);
    return;
  }
  const index = rest.findIndex((entry) => holdsPanel(entry, before));
  if (index < 0) {
    throw new Error("The insertion anchor is no longer in this Loom");
  }
  const anchor = rest[index].before;
  privatePanels.set([
    ...rest.slice(0, index),
    anchor === undefined ? { panel } : { panel, before: anchor },
    ...rest.slice(index),
  ]);
});

/**
 * Shows `panel` again in the acting principal's own view. A panel that is not
 * hidden, including one no longer in the Loom, is left alone.
 */
const unhidePanel = handler<
  { panel: Writable<Panel> },
  { hiddenPanels: Writable<Writable<Panel>[]> }
>(({ panel }, { hiddenPanels }) => {
  hiddenPanels.removeByValue(panel);
});

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

/**
 * A short name for a hidden panel, without reading a piece's protected fields:
 * its title, else its URL, else its kind.
 */
function panelLabel(panel: Writable<Panel>): string {
  const value = panel.get();
  if (value === undefined) return "A panel no longer in this Loom";
  if (value.titleOverride) return `Hidden: ${value.titleOverride}`;
  return value.kind === "url" ? `Hidden: ${value.url}` : `Hidden ${value.kind}`;
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
 * copy records the principal the duplication acted for.
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
  (
    {
      title,
      panels,
      presentation,
      participants,
      chatRoom,
      hiddenPanels,
      privatePanels,
    },
  ) => {
    const pieceRegistry = computed(() =>
      panels.get().flatMap((panel) => {
        const value = panel.get();
        return value.kind === "piece" ? [value.piece] : [];
      })
    );
    const roster = computed(() => participantEntries(participants));
    const room = computed(() => chatRoom.get().room);
    const viewerPanels = computed(() =>
      viewerList(panels.get(), hiddenPanels.get(), privatePanels.get())
    );
    const trailingPrivates = computed(() =>
      trailingPrivatePanels(
        shownPanels(panels.get(), hiddenPanels.get()),
        privatePanels.get(),
      )
    );
    const state = { panels, presentation };
    const viewerState = new Writable.perSession<ViewerState>({});
    const remove = removePanel(state);
    const move = movePanel(state);
    const duplicate = admitPanel({ panels, mode: "duplicate" });
    const viewerProfile = wish<ParticipantProfile>({ query: "#profile" });
    const present = setPresentation(state);
    const hide = hidePanel({ panels, hiddenPanels });
    const unhide = unhidePanel({ hiddenPanels });
    const removePrivate = removePrivatePanel({ privatePanels });
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
                {panels.map((panel) =>
                  ifElse(
                    computed(() => !isHidden(hiddenPanels.get(), panel)),
                    <cf-vstack gap="4">
                      {computed(() =>
                        privatePanelsBefore(privatePanels.get(), panel)
                      ).map((mine) => (
                        <cf-card>
                          <cf-hstack gap="2" wrap>
                            <span>Only you see this panel</span>
                            <cf-button
                              onClick={() =>
                                removePrivate.send({ panel: mine })}
                            >
                              Remove from my view
                            </cf-button>
                          </cf-hstack>
                          {computed(() => renderPanel(mine))}
                        </cf-card>
                      ))}
                      <cf-card>
                        <cf-hstack gap="2" wrap>
                          <cf-button
                            onClick={selectPanel({ panel, viewerState })}
                          >
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
                          <cf-button onClick={() => hide.send({ panel })}>
                            Hide for me
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
                                stagedPanels: [
                                  ...presentation.get().stagedPanels,
                                ],
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
                    </cf-vstack>,
                    null,
                  )
                )}
                {trailingPrivates.map((panel) => (
                  <cf-card>
                    <cf-hstack gap="2" wrap>
                      <span>Only you see this panel</span>
                      <cf-button
                        onClick={() => removePrivate.send({ panel })}
                      >
                        Remove from my view
                      </cf-button>
                    </cf-hstack>
                    {computed(() => renderPanel(panel))}
                  </cf-card>
                ))}
                {hiddenPanels.map((panel) => (
                  <cf-hstack gap="2">
                    <span>{computed(() => panelLabel(panel))}</span>
                    <cf-button onClick={() => unhide.send({ panel })}>
                      Show
                    </cf-button>
                  </cf-hstack>
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
      chatRoom: room,
      setChatRoom: setChatRoom({ chatRoom }),
      retitleLoom: retitleLoom({ title }),
      retitlePanel: retitlePanel({ panels }),
      retargetPanel: retargetPanel({ panels }),
      hiddenPanels,
      viewerPanels,
      hidePanel: hide,
      unhidePanel: unhide,
      privatePanels,
      addPrivatePanel: addPrivatePanel({ panels, privatePanels }),
      removePrivatePanel: removePrivate,
      movePrivatePanel: movePrivatePanel({ panels, privatePanels }),
    };
  },
);

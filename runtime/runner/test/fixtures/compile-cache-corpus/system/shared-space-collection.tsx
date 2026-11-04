/** Home's collection browser, with revision-bound archive and restore choices. */

import {
  computed,
  eventKey,
  handler,
  NAME,
  pattern,
  type PerSession,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  changeSharedSpaceMembershipIn,
  type SharedSpaceCatalogStorage,
  type SharedSpaceMembershipResult,
} from "./shared-space-catalog.ts";
import type { SharedSpaceCollectionView } from "./shared-space-interface.ts";

/** The rendered control's snapshot of the choice the person saw. */
export interface CollectionChoiceEvent {
  target: {
    dataset: { space: string; revision: string; state: string };
  };
}

/** Home-local state for applying a rendered membership choice. */
interface ChoiceState {
  catalog: Writable<SharedSpaceCatalogStorage>;
  conflict: Writable<string>;
}

/** Applies the control's observed revision, reporting a refusal in its view. */
export const chooseCollectionMembership = handler<
  CollectionChoiceEvent,
  ChoiceState,
  SharedSpaceMembershipResult
>((event, { catalog, conflict }) => {
  const { space, revision, state } = event.target.dataset;
  if (state !== "saved" && state !== "archived") {
    throw new TypeError("Collection choice requires a known membership state.");
  }
  const result = changeSharedSpaceMembershipIn(catalog, {
    space,
    expectedRevision: revision,
    state,
    id: eventKey(),
  });
  conflict.set(result.status === "conflict" ? result.reason : "");
  return result;
});

/** The owned catalog and its validated observation, supplied by Home. */
export interface SharedSpaceCollectionInput {
  catalog: Writable<SharedSpaceCatalogStorage>;
  view: SharedSpaceCollectionView;
}

/** The browser's UI and session-local controls. */
export interface SharedSpaceCollectionOutput {
  [NAME]: string;
  [UI]: VNode;
  search: PerSession<Writable<string>>;
  kind: PerSession<Writable<string>>;
  membership: PerSession<Writable<string>>;
  chooseMembership: Stream<CollectionChoiceEvent, SharedSpaceMembershipResult>;
}

/** Labels the built-in collection kinds and retains extension-kind names. */
const kindLabel = (kind: string): string =>
  kind === "loom" ? "Looms" : kind === "fabrichat-room" ? "Chats" : kind;

/** Browses Home's collection without resolving or reading any target space. */
const SharedSpaceCollection = pattern<
  SharedSpaceCollectionInput,
  SharedSpaceCollectionOutput
>(({ catalog, view }) => {
  const search = new Writable.perSession("");
  const kind = new Writable.perSession("");
  const membership = new Writable.perSession("saved");
  const conflict = new Writable.perSession("");
  const chooseMembership = chooseCollectionMembership({ catalog, conflict });
  const unavailable = computed(() => view.status !== "ready");
  const unavailableText = computed(() =>
    view.status === "unavailable" && view.reason === "malformed"
      ? "The collection could not be read. Its stored data needs attention."
      : "Loading your collection…"
  );
  const kindItems = computed(() => [
    { label: "All kinds", value: "" },
    ...(view.status === "ready"
      ? Object.keys(view.byKind).map((value) => ({
        label: kindLabel(value),
        value,
      }))
      : []),
  ]);
  const rows = computed(() => {
    if (view.status !== "ready") return [];
    const state = membership.get();
    const entries = state === "saved"
      ? view.saved
      : state === "archived"
      ? view.archived
      : view.other;
    const selectedKind = kind.get();
    const query = search.get().trim().toLowerCase();
    return entries.filter((entry) =>
      (selectedKind === "" || entry.kind === selectedKind) &&
      (query === "" ||
        [entry.title ?? "", entry.space, entry.host, entry.kind].some((text) =>
          text.toLowerCase().includes(query)
        ))
    );
  });
  const empty = computed(() => view.status === "ready" && rows.length === 0);
  const conflictText = computed(() =>
    conflict.get() === "revision"
      ? "The collection changed after this choice was shown. Review it and choose again."
      : conflict.get() === ""
      ? ""
      : "This membership choice could not be applied. Review the collection before trying again."
  );
  return {
    [NAME]: "Social spaces",
    [UI]: (
      <cf-vstack gap="3" style={{ padding: "1rem" }}>
        <cf-heading level={3}>Social spaces</cf-heading>
        <cf-text variant="body-compact" tone="muted" block>
          Spaces you have saved, including looms and chats. Archiving puts a
          space away; your access and everyone else's access stay the same.
        </cf-text>
        <cf-hstack gap="2">
          <cf-input
            $value={search}
            placeholder="Find a social space…"
            aria-label="Find a social space"
          />
          <cf-select $value={kind} items={kindItems} aria-label="Space type" />
        </cf-hstack>
        <cf-select
          $value={membership}
          aria-label="Collection membership"
          items={[
            { label: "Saved", value: "saved" },
            { label: "Archived", value: "archived" },
            { label: "Other states", value: "other" },
          ]}
        />
        {unavailable ? <cf-alert>{unavailableText}</cf-alert> : null}
        {conflictText !== "" ? <cf-alert>{conflictText}</cf-alert> : null}
        {empty ? <p>No social spaces match this view.</p> : null}
        <cf-vstack gap="2" id="home-social-space-list">
          {rows.map((entry) => (
            <cf-card>
              <cf-hstack slot="content" gap="2" align="center">
                <cf-vstack gap="1" style={{ flex: "1" }}>
                  <cf-text variant="body">{entry.title || entry.space}</cf-text>
                  <cf-space-link spaceDid={entry.space} label="Open" />
                  <cf-text variant="caption" tone="muted">
                    {kindLabel(entry.kind)} · {entry.state}
                  </cf-text>
                  <cf-text variant="caption" tone="muted">
                    <code>{entry.space}</code>
                  </cf-text>
                  <cf-text variant="caption" tone="muted">{entry.host}</cf-text>
                </cf-vstack>
                {entry.state === "saved" || entry.state === "archived"
                  ? (
                    <cf-button
                      size="sm"
                      data-space={entry.space}
                      data-revision={entry.revision}
                      data-state={entry.state === "saved"
                        ? "archived"
                        : "saved"}
                      onClick={chooseMembership}
                    >
                      {entry.state === "saved" ? "Archive" : "Restore"}
                    </cf-button>
                  )
                  : null}
              </cf-hstack>
            </cf-card>
          ))}
        </cf-vstack>
      </cf-vstack>
    ),
    search,
    kind,
    membership,
    chooseMembership,
  };
});

export default SharedSpaceCollection;

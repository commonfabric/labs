/**
 * A work snapshot: one repository's workstreams over a window of time, as a
 * synthesis job writes them. Each workstream names the people in it, the
 * topics it holds, and the pull requests that make it up. The job replaces
 * the snapshot whole through `publish`; people pin and rename through their
 * own verbs, and those records survive the next snapshot because they live
 * beside it, keyed by workstream id. A pin is a keyed record and a rename an
 * appended one, written with the mergeable methods, so two people pinning or
 * renaming at once both land. A pin or a rename names a workstream the
 * snapshot carries; one whose workstream a later snapshot drops keeps a place
 * in the derived outputs, so `unpin` stays reachable.
 *
 * The piece is the shared substrate two surfaces read: a team dashboard
 * over every workstream, and a person's own lens over the workstreams that
 * name them.
 */

import {
  action,
  computed,
  Default,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import { isSafeLinkUrl, TOPICS_THEME, whenLabel } from "../topics/topic.tsx";

//
// The snapshot, as the job writes it
//

export interface PersonRef {
  name: string;
  login?: string;
  did?: string;
  avatar?: string;
}

export interface TopicRef {
  title: string;
  url: string;
  address?: string;
  summary?: string;
  lastActivityAt?: number;
  commentCount?: number;
}

export interface PullRequestRef {
  repo: string;
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  url: string;
  author?: string;
  updatedAt: string;
  mergedAt?: string | null;
  headRef?: string;
}

export interface Workstream {
  /** Stable across snapshots; the synthesis feeds the previous one back. */
  id: string;
  name: string;
  summary: string;
  /** Logins or names, as the people list spells them. */
  people: string[];
  topics: TopicRef[];
  prs: PullRequestRef[];
}

export interface WorkSnapshot {
  schema: "commonfabric.work-snapshot";
  repository: string;
  window: { since: string; until: string };
  generatedAt: string;
  people: PersonRef[];
  workstreams: Workstream[];
}

export const WORK_SNAPSHOT_SCHEMA = "commonfabric.work-snapshot";

const EMPTY_SNAPSHOT: WorkSnapshot = {
  schema: WORK_SNAPSHOT_SCHEMA,
  repository: "",
  window: { since: "", until: "" },
  generatedAt: "",
  people: [],
  workstreams: [],
};

//
// What people add on top
//

export interface Pin {
  workstreamId: string;
  kind: "topic" | "pr";
  url: string;
  title: string;
  /** A pinned pull request's state as the pinner knew it; open otherwise. */
  state?: PullRequestRef["state"];
  pinnedAt: number;
}

export interface Rename {
  workstreamId: string;
  name: string;
  renamedAt: number;
}

//
// Verbs
//

export interface PublishEvent {
  snapshot: WorkSnapshot;
}

export interface PublishResult {
  workstreamCount: number;
  generatedAt: string;
}

/** A topic pin: any http(s) URL. */
export interface TopicPinEvent {
  workstreamId: string;
  kind: "topic";
  url: string;
  title?: string;
}

/** A pull request pin: a GitHub pull request URL, and the pull request's
 * state, so a merged or closed one is not counted open. */
export interface PullRequestPinEvent {
  workstreamId: string;
  kind: "pr";
  url: string;
  title?: string;
  state: PullRequestRef["state"];
}

export type PinEvent = TopicPinEvent | PullRequestPinEvent;

const PULL_REQUEST_STATES: ReadonlySet<string> = new Set([
  "open",
  "draft",
  "merged",
  "closed",
]);

export interface UnpinEvent {
  workstreamId: string;
  url: string;
}

export interface RenameEvent {
  workstreamId: string;
  name: string;
}

//
// Inputs and outputs
//

export interface SnapshotInput {
  snapshot?: Writable<WorkSnapshot | Default<typeof EMPTY_SNAPSHOT>>;
  pins?: Writable<Pin[] | Default<[]>>;
  renames?: Writable<Rename[] | Default<[]>>;
}

export interface SnapshotOutput {
  [NAME]: string;
  [UI]: VNode;
  snapshot: WorkSnapshot | Default<typeof EMPTY_SNAPSHOT>;
  pins: Pin[] | Default<[]>;
  renames: Rename[] | Default<[]>;
  repository: string;
  generatedAt: string;
  people: PersonRef[];
  /** The snapshot's workstreams with every pin and rename applied. */
  workstreams: Workstream[];
  /** Pins whose workstream the snapshot no longer carries. */
  orphanedPins: Pin[];
  /** Renames whose workstream the snapshot no longer carries. */
  orphanedRenames: Rename[];
  /** Replace the snapshot whole. Pins and renames stay. */
  publish: Stream<PublishEvent, PublishResult>;
  /** Pin a topic or pull request to a workstream the snapshot carries: one
   * pin per URL per workstream, so pinning it again changes nothing. The URL
   * must be http(s), and a pull request's a GitHub pull request URL. */
  pin: Stream<PinEvent>;
  /** Drop a pin. */
  unpin: Stream<UnpinEvent>;
  /** Give a workstream the snapshot carries a name of the people's choosing. */
  rename: Stream<RenameEvent>;
}

//
// Derivations
//

/** The workstreams as people see them: renamed where a rename says so, and
 * carrying every pinned topic and pull request the job did not place. Pins
 * and renames are indexed by workstream once, so the walk is linear. */
const workstreamsOf = lift((
  { snapshot, pins, renames }: {
    snapshot: WorkSnapshot;
    pins: Pin[];
    renames: Rename[];
  },
): Workstream[] => {
  const latestName = new Map<string, Rename>();
  for (const rename of renames) {
    const current = latestName.get(rename.workstreamId);
    if (!current || rename.renamedAt >= current.renamedAt) {
      latestName.set(rename.workstreamId, rename);
    }
  }
  const pinsByWorkstream = new Map<string, Pin[]>();
  for (const pin of pins) {
    const own = pinsByWorkstream.get(pin.workstreamId) ?? [];
    own.push(pin);
    pinsByWorkstream.set(pin.workstreamId, own);
  }
  return snapshot.workstreams.map((workstream) => {
    const ownPins = pinsByWorkstream.get(workstream.id) ?? [];
    const topicUrls = new Set(workstream.topics.map((t) => t.url));
    const prUrls = new Set(workstream.prs.map((p) => p.url));
    const pinnedTopics: TopicRef[] = ownPins
      .filter((p) => p.kind === "topic" && !topicUrls.has(p.url))
      .map((p) => ({ title: p.title, url: p.url }));
    const pinnedPrs: PullRequestRef[] = ownPins
      .filter((p) => p.kind === "pr" && !prUrls.has(p.url))
      .map((p) => {
        // The verb takes only a URL that parses; a stored one that does not
        // shows with no repository and the number 0 rather than vanishing.
        const parsed = parsePullRequestUrl(p.url);
        return {
          repo: parsed?.repo ?? "",
          number: parsed?.number ?? 0,
          title: p.title,
          // A pull request pin names its state; a record with none counts open.
          state: p.state ?? "open",
          url: p.url,
          updatedAt: new Date(p.pinnedAt).toISOString(),
        };
      });
    return {
      ...workstream,
      name: latestName.get(workstream.id)?.name ?? workstream.name,
      topics: [...workstream.topics, ...pinnedTopics],
      prs: [...workstream.prs, ...pinnedPrs],
    };
  });
});

/** Pins and renames keyed to a workstream the snapshot does not carry: a
 * later snapshot dropped it, or its id changed. Listed so they stay visible
 * and `unpin` stays reachable by workstream id and URL. */
const orphanedOverlayOf = lift((
  { snapshot, pins, renames }: {
    snapshot: WorkSnapshot;
    pins: Pin[];
    renames: Rename[];
  },
): { pins: Pin[]; renames: Rename[] } => {
  const carried = new Set(snapshot.workstreams.map((w) => w.id));
  return {
    pins: pins.filter((p) => !carried.has(p.workstreamId)),
    renames: renames.filter((r) => !carried.has(r.workstreamId)),
  };
});

/** The repository and number a GitHub pull request URL names, or nothing for
 * a URL that is not one: `https://github.com/<owner>/<repo>/pull/<number>`,
 * with or without a trailing path such as `/files`. */
const parsePullRequestUrl = (
  url: string,
): { repo: string; number: number } | undefined => {
  const match = url.trim().match(
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/,
  );
  return match ? { repo: match[1], number: Number(match[2]) } : undefined;
};

/** The key a pin's record lives under: one per URL per workstream. A key
 * this piece alone defines is spelled as a JSON array, which needs no
 * escaping rule of its own; a key another contract defines, the connector's
 * session key in `workbench/sessions.ts`, is spelled the way that contract
 * spells it. */
const pinKey = (workstreamId: string, url: string): string =>
  JSON.stringify([workstreamId, url]);

const stateColor = (
  state: PullRequestRef["state"],
): "primary" | "accent" | "neutral" | "danger" =>
  state === "merged"
    ? "primary"
    : state === "open"
    ? "accent"
    : state === "draft"
    ? "neutral"
    : "danger";

/** The snapshot's own header facts, read through one lift. */
const headerOf = lift((
  { snapshot }: { snapshot: WorkSnapshot },
): {
  repository: string;
  generatedAt: string;
  since: string;
  until: string;
  people: PersonRef[];
  hasSnapshot: boolean;
} => ({
  repository: snapshot.repository ?? "",
  generatedAt: snapshot.generatedAt ?? "",
  since: snapshot.window?.since ?? "",
  until: snapshot.window?.until ?? "",
  people: snapshot.people ?? [],
  hasSnapshot: (snapshot.repository ?? "").trim().length > 0,
}));

//
// The pattern
//

export default pattern<SnapshotInput, SnapshotOutput>(
  ({ snapshot, pins, renames }) => {
    const workstreams = workstreamsOf({ snapshot, pins, renames });
    const orphaned = orphanedOverlayOf({ snapshot, pins, renames });
    const orphanedPins = orphaned.pins;
    const orphanedRenames = orphaned.renames;
    const hasOrphans = computed(() =>
      orphanedPins.length + orphanedRenames.length > 0
    );
    const header = headerOf({ snapshot });
    const repository = header.repository;
    const generatedAt = header.generatedAt;
    const people = header.people;
    const hasSnapshot = header.hasSnapshot;

    const publish = action<PublishEvent, PublishResult>(
      (event) => {
        // A snapshot the typed boundary cannot read (workstreams that are
        // not an array, say) reaches the verb as no event at all; it is
        // refused here by name, and what the boundary admits is checked
        // below.
        const next = event?.snapshot;
        if (!next || next.schema !== WORK_SNAPSHOT_SCHEMA) {
          throw new Error(
            `publish: snapshot.schema must be ${WORK_SNAPSHOT_SCHEMA}`,
          );
        }
        if (!next.repository?.trim()) {
          throw new Error("publish: snapshot.repository is required");
        }
        const ids = new Set<string>();
        for (const workstream of next.workstreams) {
          if (!workstream.id?.trim()) {
            throw new Error("publish: every workstream needs an id");
          }
          // An id is what pins and renames name; one with surrounding
          // whitespace could never be named, and two differing only by it
          // would pass as distinct.
          if (workstream.id !== workstream.id.trim()) {
            throw new Error(
              `publish: workstream id "${workstream.id}" carries surrounding whitespace`,
            );
          }
          if (ids.has(workstream.id)) {
            throw new Error(
              `publish: duplicate workstream id ${workstream.id}`,
            );
          }
          ids.add(workstream.id);
          for (const link of [...workstream.topics, ...workstream.prs]) {
            if (!isSafeLinkUrl(link.url)) {
              throw new Error(
                `publish: workstream ${workstream.id} carries a link that is not http(s)`,
              );
            }
          }
        }
        snapshot.set(next);
        return {
          workstreamCount: next.workstreams.length,
          generatedAt: next.generatedAt,
        };
      },
    );

    const pin = action<PinEvent>(
      (event) => {
        const { workstreamId, kind, url, title } = event;
        // The typed boundary does not enforce string literals, so a pull
        // request pin's state is checked here as well as by the type.
        const state = event.kind === "pr" ? event.state : undefined;
        const id = (workstreamId ?? "").trim();
        const target = (url ?? "").trim();
        if (!id || !target || (kind !== "topic" && kind !== "pr")) {
          throw new Error("pin: workstreamId, kind, and url are required");
        }
        if (!isSafeLinkUrl(target)) {
          throw new Error("pin: url must be http(s)");
        }
        if (kind === "pr" && !PULL_REQUEST_STATES.has(state ?? "")) {
          throw new Error(
            "pin: a pull request pin needs its state (open, draft, merged, or closed)",
          );
        }
        if (kind === "pr" && parsePullRequestUrl(target) === undefined) {
          throw new Error(
            "pin: a pull request pin's url must be a GitHub pull request URL",
          );
        }
        if (!snapshot.get().workstreams.some((w) => w.id === id)) {
          throw new Error(
            `pin: workstreamId must name a workstream the snapshot carries, not ${id}`,
          );
        }
        // The record is keyed, so two people pinning at once both land, and
        // membership is a server-side add-if-absent. The record is written
        // only when empty, so pinning again keeps the first title and time.
        const record = pins.elementById(pinKey(id, target));
        if (record.get() === undefined) {
          record.set({
            workstreamId: id,
            kind,
            url: target,
            title: (title ?? "").trim() || target,
            ...(kind === "pr" && state ? { state } : {}),
            pinnedAt: Date.now(),
          });
        }
        pins.addUnique(record);
      },
    );

    const unpin = action<UnpinEvent>(({ workstreamId, url }) => {
      const key = pinKey((workstreamId ?? "").trim(), (url ?? "").trim());
      pins.removeByValue(pins.elementById(key));
      // The record outlives its membership; cleared, a later pin of the same
      // URL starts fresh rather than reviving this one.
      const record: Writable<Pin | undefined> = pins.elementById(key);
      record.set(undefined);
    });

    const rename = action<RenameEvent>(({ workstreamId, name }) => {
      const id = (workstreamId ?? "").trim();
      const next = (name ?? "").trim();
      if (!id || !next) {
        throw new Error("rename: workstreamId and name are required");
      }
      if (!snapshot.get().workstreams.some((w) => w.id === id)) {
        throw new Error(
          `rename: workstreamId must name a workstream the snapshot carries, not ${id}`,
        );
      }
      // Appended, never rewritten; the newest rename names the workstream.
      renames.push({ workstreamId: id, name: next, renamedAt: Date.now() });
    });

    return {
      [NAME]: hasSnapshot
        ? `Workstreams: ${repository}`
        : "Workstreams (empty)",
      [UI]: (
        <cf-theme theme={TOPICS_THEME}>
          <cf-screen>
            <cf-vstack slot="header" gap="1" padding="4">
              <cf-text
                block
                style="font-size: 1.25rem; font-weight: 600;"
              >
                {hasSnapshot ? `Workstreams · ${repository}` : "Workstreams"}
              </cf-text>
              <cf-text variant="caption" tone="muted">
                {hasSnapshot
                  ? `${workstreams.length} workstreams · ${people.length} people · window ${header.since} to ${header.until} · synthesized ${generatedAt}`
                  : "No snapshot published yet."}
              </cf-text>
            </cf-vstack>
            <cf-vstack gap="3" padding="4">
              {workstreams.map((workstream) => (
                <cf-card data-workstream="">
                  <cf-vstack gap="2">
                    <cf-hstack justify="between" align="center">
                      <cf-heading level={5}>{workstream.name}</cf-heading>
                      <cf-text variant="caption" tone="muted">
                        {workstream.people.join(", ")}
                      </cf-text>
                    </cf-hstack>
                    <cf-text tone="muted" block>{workstream.summary}</cf-text>
                    <cf-text variant="caption" tone="muted">
                      Topics · {workstream.topics.length}
                    </cf-text>
                    {workstream.topics.map((topic) => (
                      <cf-hstack gap="2" align="center" data-topic-row="">
                        {isSafeLinkUrl(topic.url)
                          ? (
                            <a
                              href={topic.url}
                              target="_blank"
                              rel="noreferrer"
                              style="color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                            >
                              {topic.title}
                            </a>
                          )
                          : (
                            <cf-text
                              tone="muted"
                              style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                            >
                              {topic.title}
                            </cf-text>
                          )}
                        <cf-text variant="caption" tone="muted">
                          {topic.lastActivityAt
                            ? whenLabel(topic.lastActivityAt)
                            : ""}
                        </cf-text>
                      </cf-hstack>
                    ))}
                    <cf-text variant="caption" tone="muted">
                      Pull requests · {workstream.prs.length}
                    </cf-text>
                    {workstream.prs.map((pr) => (
                      <cf-hstack gap="2" align="center" data-pr-row="">
                        <cf-badge size="xs" color={stateColor(pr.state)}>
                          {pr.state}
                        </cf-badge>
                        {isSafeLinkUrl(pr.url)
                          ? (
                            <a
                              href={pr.url}
                              target="_blank"
                              rel="noreferrer"
                              style="color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                            >
                              #{pr.number} {pr.title}
                            </a>
                          )
                          : (
                            <cf-text
                              tone="muted"
                              style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                            >
                              #{pr.number} {pr.title}
                            </cf-text>
                          )}
                        <cf-text variant="caption" tone="muted">
                          {pr.updatedAt.slice(0, 10)}
                        </cf-text>
                      </cf-hstack>
                    ))}
                  </cf-vstack>
                </cf-card>
              ))}
              {hasOrphans
                ? (
                  <cf-card data-orphaned="">
                    <cf-vstack gap="2">
                      <cf-heading level={5}>
                        Pinned or renamed on work no longer shown
                      </cf-heading>
                      <cf-text variant="caption" tone="muted">
                        The snapshot no longer carries these workstreams; a pin
                        is dropped with `unpin`, by workstream id and URL.
                      </cf-text>
                      {orphanedPins.map((pin) => (
                        <cf-text block data-orphan-pin="">
                          {`${pin.kind} · ${pin.title} · workstream ${pin.workstreamId} · ${pin.url}`}
                        </cf-text>
                      ))}
                      {orphanedRenames.map((rename) => (
                        <cf-text block data-orphan-rename="">
                          {`workstream ${rename.workstreamId} renamed "${rename.name}"`}
                        </cf-text>
                      ))}
                    </cf-vstack>
                  </cf-card>
                )
                : null}
            </cf-vstack>
          </cf-screen>
        </cf-theme>
      ),
      snapshot,
      pins,
      renames,
      repository,
      generatedAt,
      people,
      workstreams,
      orphanedPins,
      orphanedRenames,
      publish,
      pin,
      unpin,
      rename,
    };
  },
);

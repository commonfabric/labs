import {
  action,
  Default,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import { TOPICS_THEME, whenLabel } from "../topics/topic.tsx";

// ===== What this is =====
//
// A work snapshot: one repository's workstreams over a window of time, as a
// synthesis job writes them. Each workstream names the people in it, the
// topics it holds, and the pull requests that make it up. The job replaces
// the snapshot whole through `publish`; people pin and rename through their
// own verbs, and those records survive the next snapshot because they live
// beside it, keyed by workstream id.
//
// The piece is the shared substrate two surfaces read: a team dashboard
// over every workstream, and a person's own lens over the workstreams that
// name them.

// ===== The snapshot, as the job writes it =====

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

// ===== What people add on top =====

export interface Pin {
  workstreamId: string;
  kind: "topic" | "pr";
  url: string;
  title: string;
  pinnedAt: number;
}

export interface Rename {
  workstreamId: string;
  name: string;
  renamedAt: number;
}

// ===== Verbs =====

export interface PublishEvent {
  snapshot: WorkSnapshot;
}

export interface PublishResult {
  workstreamCount: number;
  generatedAt: string;
}

export interface PinEvent {
  workstreamId: string;
  kind: "topic" | "pr";
  url: string;
  title?: string;
}

export interface UnpinEvent {
  workstreamId: string;
  url: string;
}

export interface RenameEvent {
  workstreamId: string;
  name: string;
}

// ===== Inputs and outputs =====

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
  /** Replace the snapshot whole. Pins and renames stay. */
  publish: Stream<PublishEvent, PublishResult>;
  /** Pin a topic or pull request to a workstream. Idempotent by URL. */
  pin: Stream<PinEvent>;
  /** Drop a pin. */
  unpin: Stream<UnpinEvent>;
  /** Give a workstream a name of the people's choosing. */
  rename: Stream<RenameEvent>;
}

// ===== Derivations =====

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
      .map((p) => ({
        repo: repoOfPullRequestUrl(p.url),
        number: numberOfPullRequestUrl(p.url),
        title: p.title,
        state: "open",
        url: p.url,
        updatedAt: new Date(p.pinnedAt).toISOString(),
      }));
    return {
      ...workstream,
      name: latestName.get(workstream.id)?.name ?? workstream.name,
      topics: [...workstream.topics, ...pinnedTopics],
      prs: [...workstream.prs, ...pinnedPrs],
    };
  });
});

const repoOfPullRequestUrl = (url: string): string => {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return match ? match[1] : "";
};

const numberOfPullRequestUrl = (url: string): number => {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : 0;
};

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

// ===== The pattern =====

export default pattern<SnapshotInput, SnapshotOutput>(
  ({ snapshot, pins, renames }) => {
    const workstreams = workstreamsOf({ snapshot, pins, renames });
    const header = headerOf({ snapshot });
    const repository = header.repository;
    const generatedAt = header.generatedAt;
    const people = header.people;
    const hasSnapshot = header.hasSnapshot;

    const publish = action<PublishEvent, PublishResult>(
      ({ snapshot: next }) => {
        if (!next || next.schema !== WORK_SNAPSHOT_SCHEMA) {
          throw new Error(
            `publish: snapshot.schema must be ${WORK_SNAPSHOT_SCHEMA}`,
          );
        }
        if (!next.repository?.trim()) {
          throw new Error("publish: snapshot.repository is required");
        }
        if (!Array.isArray(next.workstreams)) {
          throw new Error("publish: snapshot.workstreams must be an array");
        }
        const ids = new Set<string>();
        for (const workstream of next.workstreams) {
          if (!workstream.id?.trim()) {
            throw new Error("publish: every workstream needs an id");
          }
          if (ids.has(workstream.id)) {
            throw new Error(
              `publish: duplicate workstream id ${workstream.id}`,
            );
          }
          ids.add(workstream.id);
        }
        snapshot.set(next);
        return {
          workstreamCount: next.workstreams.length,
          generatedAt: next.generatedAt,
        };
      },
    );

    const pin = action<PinEvent>(({ workstreamId, kind, url, title }) => {
      const id = (workstreamId ?? "").trim();
      const target = (url ?? "").trim();
      if (!id || !target || (kind !== "topic" && kind !== "pr")) {
        throw new Error("pin: workstreamId, kind, and url are required");
      }
      const current = pins.get();
      if (current.some((p) => p.workstreamId === id && p.url === target)) {
        return;
      }
      pins.set([
        ...current,
        {
          workstreamId: id,
          kind,
          url: target,
          title: (title ?? "").trim() || target,
          pinnedAt: Date.now(),
        },
      ]);
    });

    const unpin = action<UnpinEvent>(({ workstreamId, url }) => {
      pins.set(
        pins.get().filter((p) =>
          !(p.workstreamId === workstreamId && p.url === url)
        ),
      );
    });

    const rename = action<RenameEvent>(({ workstreamId, name }) => {
      const id = (workstreamId ?? "").trim();
      const next = (name ?? "").trim();
      if (!id || !next) {
        throw new Error("rename: workstreamId and name are required");
      }
      renames.set([
        ...renames.get(),
        { workstreamId: id, name: next, renamedAt: Date.now() },
      ]);
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
                        <a
                          href={topic.url}
                          target="_blank"
                          rel="noreferrer"
                          style="color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                        >
                          {topic.title}
                        </a>
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
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noreferrer"
                          style="color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"
                        >
                          #{pr.number} {pr.title}
                        </a>
                        <cf-text variant="caption" tone="muted">
                          {pr.updatedAt.slice(0, 10)}
                        </cf-text>
                      </cf-hstack>
                    ))}
                  </cf-vstack>
                </cf-card>
              ))}
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
      publish,
      pin,
      unpin,
      rename,
    };
  },
);

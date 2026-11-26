/**
 * Builds what the runners page shows from the jobs queued and running and the
 * runners GitHub lists: pools of runners, each a set of runners that the same
 * jobs can run on, with the jobs queued for the pool, and its runners in
 * boxes, a box for each machine with runners of its own, each runner a slot,
 * or a box for each kind of runner that comes and goes with the jobs it runs.
 *
 * Everything here runs in the browser, handed to it by name by
 * runners-page.ts, so each declaration uses only the others and its own
 * nested helpers.
 */

import type { ActiveJob, News, TrackerSnapshot } from "./runner-jobs.ts";

/** What the server says down the runners page's socket. */
export type RunnersMessage =
  | {
    readonly type: "snapshot";
    readonly version: string;
    readonly tracker: TrackerSnapshot;
    readonly runners: readonly Runner[];
    readonly larger: readonly LargerRunner[];
    readonly problems: readonly string[];
  }
  | { readonly type: "news"; readonly news: News }
  /** Says the server is still there, on its tick, so that a page can tell a dead socket. */
  | { readonly type: "ping" }
  | {
    readonly type: "runners";
    readonly runners: readonly Runner[];
    readonly larger: readonly LargerRunner[];
    readonly problems: readonly string[];
  };

/** What a runners page says up its socket: whether a reader can see it. */
export interface PageMessage {
  readonly type: "visible";
  readonly visible: boolean;
}

/** A self-hosted runner, as GitHub's API lists it. */
export interface Runner {
  /** The organization, or the user, whose runner it is. */
  readonly owner: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly online: boolean;
}

/**
 * One of an organization's larger runners: a kind of runner that GitHub
 * starts for each job, up to `maximum` at once, as GitHub's API lists them.
 */
export interface LargerRunner {
  readonly owner: string;
  readonly name: string;
  readonly maximum: number | null;
  readonly cores: number | null;
  readonly memory: number | null;
}

/** A job on the board. */
export interface Token {
  readonly id: number;
  /** The job's name. */
  readonly job: string;
  readonly repository: string;
  readonly workflow: string;
  readonly branch: string;
  readonly pullRequest: number | null;
  /** The first digits of the commit its run runs. */
  readonly commit: string;
  /** The run's ID, which tells runs apart by color. */
  readonly runId: string;
  readonly running: boolean;
  /** When it was queued, or started, in milliseconds. */
  readonly since: number | null;
  readonly labels: readonly string[];
  readonly runner: string | null;
  readonly url: string;
  /** The run's page on GitHub. */
  readonly runUrl: string;
}

/** A runner of a machine, or a place a job keeps in a box of places. */
export interface Slot {
  /** What tells it apart from every other slot. */
  readonly id: string;
  readonly name: string;
  /** The runner's name without its machine's. */
  readonly label: string;
  readonly online: boolean;
  job: Token | null;
  /** Whether it is a place in a box of places rather than a runner. */
  readonly place: boolean;
}

/** A machine's runners, or the runners of one kind that come and go. */
export interface Box {
  readonly id: string;
  /** Empty for the only box of a pool, which the pool's title names. */
  readonly title: string;
  /** A slot for each runner of a machine, or places; `null` before places. */
  slots: Slot[] | null;
  /**
   * The jobs running on runners that come and go, before they are given
   * places, or, beside a machine's slots, those that say they run on a
   * runner whose slot another holds.
   */
  jobs: Token[];
  /** How many runners that come and go are online and idle. */
  idle: number;
  /** How many jobs the box's runners can run at once, when known. */
  readonly capacity: number | null;
}

/** What kind of runners a pool has, in the order the board lists them. */
export type PoolKind = 0 | 1 | 2 | 3;

/** A set of runners that the same jobs can run on. */
export interface Pool {
  readonly id: string;
  /** 0 for machines, 1 for runners that come and go, 2 for a larger runner, 3 for GitHub's. */
  readonly kind: PoolKind;
  readonly title: string;
  readonly detail: string;
  boxes: Box[];
  /** The jobs queued for the pool, the oldest first. */
  queue: Token[];
}

/** A run with jobs on the board, and how many. */
export interface BoardRun {
  readonly id: string;
  readonly jobs: number;
}

/** Everything the runners page shows. */
export interface Board {
  pools: Pool[];
  /** The runs of the jobs on the board, those with the most first. */
  readonly runs: readonly BoardRun[];
  /** What is wrong, in words. */
  readonly problems: readonly string[];
}

/**
 * What the page remembers while it shows, so that nothing on it moves that
 * need not: every pool and box it has shown, in the order it first showed
 * them, which place each running job has, and how many places each box has
 * had at most.
 */
export interface Steadiness {
  pools: Pool[];
  /** Each job's place, by the key of its box and its ID. */
  places: Map<string, number>;
  counts: Map<string, number>;
}

/**
 * Returns -1, 0 or 1 as `a` sorts before, with, or after `b`, comparing
 * their elements in turn.
 */
export function compareTuples(
  a: readonly (number | string)[],
  b: readonly (number | string)[],
): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/** Returns `text` with each full commit hash in it cut to seven digits. */
export function abbreviateHashes(text: string): string {
  return text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, "$1");
}

/**
 * Returns what a run is, as a line of the legend and a tooltip name it: its
 * repository and workflow, its pull request, or else its branch, and its
 * commit, as `labs PR #12 · CI @ 1a2b3c4` or `labs · CI on main @ 1a2b3c4`.
 */
export function runTitle(token: Token): string {
  const title = token.pullRequest === null
    ? `${token.repository} · ${token.workflow} on ${abbreviateHashes(token.branch)}`
    : `${token.repository} PR #${token.pullRequest} · ${token.workflow}`;
  return token.commit === "" ? title : `${title} @ ${token.commit}`;
}

/** Returns every token on `board`: queued, in slots, and beside them. */
export function boardTokens(board: Board): Token[] {
  const tokens: Token[] = [];
  for (const pool of board.pools) {
    for (const token of pool.queue) tokens.push(token);
    for (const box of pool.boxes) {
      for (const slot of box.slots ?? []) if (slot.job) tokens.push(slot.job);
      for (const token of box.jobs) tokens.push(token);
    }
  }
  return tokens;
}

/** Returns how many jobs run in `box`. */
export function boxRunning(box: Box): number {
  let running = box.jobs.length;
  for (const slot of box.slots ?? []) if (slot.job) running++;
  return running;
}

/** Returns how many of the runners in `box` are offline. */
export function boxOffline(box: Box): number {
  return (box.slots ?? []).filter((slot) => !slot.online).length;
}

/**
 * Returns what a pool of machines is called: its machine's name, or what the
 * names of its machines start with, without the numbers that tell them
 * apart, or, failing that, all their names.
 */
export function poolTitle(machines: readonly string[]): string {
  if (machines.length <= 1) return machines[0] ?? "";
  let prefix = machines[0];
  for (const machine of machines.slice(1)) {
    let same = 0;
    while (same < prefix.length && prefix[same] === machine[same]) same++;
    prefix = prefix.slice(0, same);
  }
  const trimmed = prefix.replace(/[-_ 0-9]+$/, "");
  return trimmed === "" ? machines.join(", ") : trimmed;
}

/**
 * Builds the board for `jobs`, queued and running, on `listed`, the
 * self-hosted runners GitHub lists, and on those the jobs say they run on,
 * which it may not have listed, and on `larger`, the larger runners.
 *
 * A runner whose name is one of its labels, or one of its labels, a dash and
 * a word, as `ci-mac-01-3` is, and that has another label to say what it is
 * for, is on the machine that label names, and has a slot in its box.
 * Machines that share a label other than their names are one pool, with
 * every machine that shares one with them. Other runners not in GitHub's own
 * group are pooled by their labels, with a box that grows with the jobs on
 * them. Each larger runner is a pool of its own. GitHub's own runners are one
 * pool, with a box for each set of labels jobs ask for. A queued job waits in
 * the pool of the first online runner that has every label it asks for, or,
 * with none online, of the first that has; failing that, in the pool of the
 * larger runner it names, or of runners with the labels it asks for, made for
 * it if it asks for a self-hosted runner; and failing that, for one of
 * GitHub's.
 */
export function buildBoard(
  jobs: Iterable<ActiveJob>,
  listed: readonly Runner[],
  larger: readonly LargerRunner[],
  pullRequest: (runId: number) => number | undefined,
  problems: readonly string[],
): Board {
  const SYSTEM = [
    "self-hosted",
    "linux",
    "macos",
    "windows",
    "x64",
    "arm64",
    "arm",
  ];
  const HOSTED_GROUP = "GitHub Actions";
  const HOSTED = "github-hosted";
  const lower = (text: string) => text.toLowerCase();
  const isSystem = (label: string) => SYSTEM.includes(lower(label));
  // The labels that say which jobs a runner takes, rather than what system
  // it runs, each once however it is written, in order.
  const distinctive = (labels: readonly string[]): string[] => {
    const seen = new Set<string>();
    return labels.filter((label) => {
      if (isSystem(label) || seen.has(lower(label))) return false;
      seen.add(lower(label));
      return true;
    }).sort((a, b) => compareTuples([lower(a)], [lower(b)]));
  };
  const key = (labels: readonly string[]) => distinctive(labels).map(lower).join(", ");
  const system = (labels: readonly string[]): string => {
    const seen = new Set<string>();
    return labels.filter((label) => {
      if (!isSystem(label) || seen.has(lower(label))) return false;
      seen.add(lower(label));
      return true;
    }).join(" ");
  };
  const joined = (parts: readonly string[]) => parts.filter((part) => part !== "").join(" · ");
  const selfHosted = (labels: readonly string[]) => labels.some((label) => lower(label) === "self-hosted");
  // The labels a running job asked for, or, for one that asked for a runner
  // group instead, as `runs-on: group:` does, that group.
  const asked = (job: ActiveJob): readonly string[] =>
    job.labels.length ? job.labels : job.runnerGroup ? [`runner group ${job.runnerGroup}`] : [];
  // Whether a running job runs on one of GitHub's own runners, as its
  // runner's group or name says, or, for a job that does not yet say where it
  // runs, as its labels do.
  const isHosted = (job: ActiveJob) =>
    job.runnerGroup === HOSTED_GROUP ||
    ((job.runner?.startsWith(`${HOSTED_GROUP} `) ?? false) && !selfHosted(job.labels)) ||
    (job.runnerGroup === null && job.runner === null && !selfHosted(job.labels));
  const token = (job: ActiveJob): Token => ({
    id: job.id,
    job: abbreviateHashes(job.name),
    repository: job.repository,
    workflow: abbreviateHashes(job.workflow),
    branch: job.branch,
    pullRequest: pullRequest(job.runId) ?? null,
    commit: job.sha.slice(0, 7),
    runId: String(job.runId),
    running: job.running,
    since: job.since,
    labels: job.labels,
    runner: job.runner,
    url: job.url,
    runUrl: `https://github.com/${job.owner}/${job.repository}/actions/runs/${job.runId}`,
  });

  const active = [...jobs].sort((a, b) => a.id - b.id);
  const runners = [...listed];
  const known = new Set(listed.map((runner) => `${runner.owner}/${runner.name}`));
  // The larger runner a job runs on, or, queued, asks for: the one its runner
  // is named after, or that it names, the longest such.
  const largerRunner = (job: ActiveJob): LargerRunner | undefined => {
    if (selfHosted(job.labels)) return undefined;
    const runner = lower(job.runner ?? "");
    const labels = new Set(job.labels.map(lower));
    let found: LargerRunner | undefined;
    for (const candidate of larger) {
      const name = lower(candidate.name);
      if (
        candidate.owner === job.owner &&
        (labels.has(name) || runner === name || runner.startsWith(`${name}-`)) &&
        (found === undefined || candidate.name.length > found.name.length)
      ) {
        found = candidate;
      }
    }
    return found;
  };
  const pools = new Map<string, Pool>();
  const largerPool = (runner: LargerRunner): string => {
    const id = `larger ${runner.owner}/${lower(runner.name)}`;
    if (!pools.has(id)) {
      const size = [
        runner.cores === null ? "" : `${runner.cores} cores`,
        runner.memory === null ? "" : `${runner.memory} GB`,
      ].filter((part) => part !== "").join(", ");
      pools.set(id, {
        id,
        kind: 2,
        title: runner.name,
        detail: joined(["GitHub-hosted", size]),
        boxes: [{
          id: lower(runner.name),
          title: "",
          slots: null,
          jobs: [],
          idle: 0,
          capacity: runner.maximum,
        }],
        queue: [],
      });
    }
    return id;
  };
  for (const job of active) {
    if (!job.running || isHosted(job) || largerRunner(job) || job.runner === null) continue;
    const id = `${job.owner}/${job.runner}`;
    if (known.has(id)) continue;
    known.add(id);
    runners.push({ owner: job.owner, name: job.runner, labels: asked(job), online: true });
  }

  // Where each runner is: its pool, its box, and whether it has a slot.
  const places = new Map<string, { pool: string; box: string; slot: boolean; runner: Runner }>();
  const machines = new Map<string, { name: string; runners: Runner[] }>();
  const comeAndGo = new Map<string, Runner[]>();
  for (const runner of runners) {
    const labels = distinctive(runner.labels);
    const name = lower(runner.name);
    // A machine's label says where a runner is, so another must say what it
    // is for.
    let machine: string | undefined;
    if (labels.length >= 2) {
      for (const label of labels) {
        const l = lower(label);
        const matches = name === l ||
          (name.startsWith(`${l}-`) && !name.slice(l.length + 1).includes("-"));
        if (matches && (machine === undefined || label.length > machine.length)) {
          machine = label;
        }
      }
    }
    if (machine !== undefined) {
      const entry = machines.get(lower(machine)) ?? { name: machine, runners: [] };
      entry.runners.push(runner);
      machines.set(lower(machine), entry);
    } else {
      const k = key(runner.labels);
      comeAndGo.set(k, [...(comeAndGo.get(k) ?? []), runner]);
    }
  }
  // Machines that share a label other than their names take the same jobs, so
  // they are one pool, with every machine that shares a label with any of
  // them.
  const machinePools: {
    roles: Set<string>;
    members: { name: string; runners: Runner[] }[];
  }[] = [];
  for (const [machine, members] of [...machines].sort((a, b) => compareTuples([a[0]], [b[0]]))) {
    const roles = new Set(
      distinctive(members.runners.flatMap((runner) => runner.labels)).map(lower),
    );
    roles.delete(machine);
    const pool = { roles, members: [members] };
    for (let index = machinePools.length - 1; index >= 0; index--) {
      const other = machinePools[index];
      if (![...other.roles].some((role) => roles.has(role))) continue;
      for (const role of other.roles) pool.roles.add(role);
      for (const member of other.members) pool.members.push(member);
      machinePools.splice(index, 1);
    }
    machinePools.push(pool);
  }
  for (const { members: unsorted } of machinePools) {
    const members = [...unsorted].sort((a, b) => compareTuples([a.name], [b.name]));
    const names = new Set(members.map((member) => lower(member.name)));
    const labels = members.flatMap((member) => member.runners.flatMap((runner) => runner.labels));
    const roles = distinctive(labels).filter((label) => !names.has(lower(label))).join(", ");
    const id = `machines ${members.map((member) => member.name).join(", ")}`;
    pools.set(id, {
      id,
      kind: 0,
      title: poolTitle(members.map((member) => member.name)),
      detail: joined([system(labels), roles]),
      boxes: members.map(({ name: machine, runners }) => {
        const slots = runners.map((runner): Slot => {
          places.set(`${runner.owner}/${runner.name}`, { pool: id, box: machine, slot: true, runner });
          const label = runner.name.slice(machine.length + 1);
          return {
            id: `${runner.owner}/${runner.name}`,
            name: runner.name,
            label: label === "" ? runner.name : label,
            online: runner.online,
            job: null,
            place: false,
          };
        });
        const order = (slot: Slot) => {
          const number = /^\d+$/.test(slot.label) ? Number(slot.label) : Infinity;
          return [number, slot.label, slot.id];
        };
        slots.sort((a, b) => compareTuples(order(a), order(b)));
        return { id: machine, title: machine, slots, jobs: [], idle: 0, capacity: null };
      }),
      queue: [],
    });
  }
  // The pool of runners with `labels`, made if there is none yet.
  const comeAndGoPool = (labels: readonly string[]): string => {
    const k = key(labels);
    const id = `labelled ${k}`;
    if (!pools.has(id)) {
      const title = distinctive(labels).join(", ");
      pools.set(id, {
        id,
        kind: 1,
        title: title === "" ? "unlabelled" : title,
        detail: system(labels),
        boxes: [{ id: k, title: "", slots: null, jobs: [], idle: 0, capacity: null }],
        queue: [],
      });
    }
    return id;
  };
  for (const group of comeAndGo.values()) {
    const id = comeAndGoPool(group.flatMap((runner) => runner.labels));
    for (const runner of group) {
      places.set(`${runner.owner}/${runner.name}`, {
        pool: id,
        box: pools.get(id)!.boxes[0].id,
        slot: false,
        runner,
      });
    }
  }
  // The box of GitHub's runners with a job's labels, made if there is none.
  const hostedBox = (job: ActiveJob): string => {
    // The same labels asked for in any order and case are one box.
    const seen = new Set<string>();
    const labels = job.labels.filter((label) => !seen.has(lower(label)) && seen.add(lower(label)))
      .sort((a, b) => compareTuples([lower(a)], [lower(b)]));
    const title = labels.length ? labels.join(", ") : "any runner";
    if (!pools.has(HOSTED)) {
      pools.set(HOSTED, {
        id: HOSTED,
        kind: 3,
        title: "GitHub-hosted",
        detail: "a fresh runner for each job",
        boxes: [],
        queue: [],
      });
    }
    const pool = pools.get(HOSTED)!;
    if (!pool.boxes.some((box) => box.id === lower(title))) {
      pool.boxes.push({ id: lower(title), title, slots: null, jobs: [], idle: 0, capacity: null });
    }
    return lower(title);
  };
  const add = (job: Token, pool: string, box: string) => {
    pools.get(pool)?.boxes.find((candidate) => candidate.id === box)?.jobs.push(job);
  };

  // The jobs running, each where it runs: in its runner's slot, or, should
  // two jobs say they run on one runner, as deliveries out of order can,
  // beside the slots.
  for (const job of active) {
    if (!job.running) continue;
    const place = job.runner === null ? undefined : places.get(`${job.owner}/${job.runner}`);
    if (isHosted(job)) {
      add(token(job), HOSTED, hostedBox(job));
    } else if (place !== undefined) {
      const slot = place.slot
        ? pools.get(place.pool)?.boxes.find((box) => box.id === place.box)?.slots?.find(
          (slot) => slot.id === `${job.owner}/${job.runner}` && slot.job === null,
        )
        : undefined;
      if (slot) slot.job = token(job);
      else add(token(job), place.pool, place.box);
    } else {
      const runner = largerRunner(job);
      if (runner) {
        const pool = largerPool(runner);
        add(token(job), pool, pools.get(pool)!.boxes[0].id);
      } else {
        add(token(job), comeAndGoPool(asked(job)), key(asked(job)));
      }
    }
  }
  for (const pool of pools.values()) {
    if (pool.kind !== 1) continue;
    const box = pool.boxes[0];
    const busy = new Set(box.jobs.map((job) => job.runner));
    box.idle = (comeAndGo.get(box.id) ?? []).filter((runner) =>
      runner.online && !busy.has(runner.name)
    ).length;
  }

  // The jobs queued, each in the queue of the pool that will take it. Online
  // runners come first, as offline ones take nothing.
  const poolOrder = (pool: Pool) => [pool.kind, pool.title, pool.id];
  const order = [...pools.values()].sort((a, b) => compareTuples(poolOrder(a), poolOrder(b)))
    .map((pool) => pool.id);
  const candidates = [...places].map(([id, place]) => ({
    pool: place.pool,
    order: [place.runner.online ? 0 : 1, order.indexOf(place.pool), id],
    labels: new Set(place.runner.labels.map(lower)),
  })).sort((a, b) => compareTuples(a.order, b.order));
  for (const job of active) {
    if (job.running) continue;
    const labels = asked(job);
    const wanted = labels.map(lower);
    const runner = wanted.length
      ? candidates.find((candidate) => wanted.every((label) => candidate.labels.has(label)))
      : undefined;
    let pool: string;
    const named = largerRunner(job);
    if (runner) {
      pool = runner.pool;
    } else if (named) {
      pool = largerPool(named);
    } else if (
      selfHosted(labels) || job.labels.length < labels.length ||
      (key(labels) !== "" && pools.has(`labelled ${key(labels)}`))
    ) {
      pool = comeAndGoPool(labels);
    } else {
      hostedBox(job);
      pool = HOSTED;
    }
    pools.get(pool)!.queue.push(token(job));
  }

  // Everything in the order the board shows it: pools by kind and name,
  // GitHub's boxes by name, and jobs the oldest first.
  const older = (a: Token, b: Token) =>
    compareTuples([a.since ?? Infinity, a.id], [b.since ?? Infinity, b.id]);
  const sorted = [...pools.values()].sort((a, b) => compareTuples(poolOrder(a), poolOrder(b)));
  for (const pool of sorted) {
    pool.queue.sort(older);
    if (pool.kind === 3) pool.boxes.sort((a, b) => compareTuples([a.title], [b.title]));
    for (const box of pool.boxes) box.jobs.sort(older);
  }
  const board: Board = { pools: sorted, runs: [], problems };
  const counts = new Map<string, number>();
  for (const token of boardTokens(board)) {
    counts.set(token.runId, (counts.get(token.runId) ?? 0) + 1);
  }
  const runs = [...counts].map(([id, count]) => ({ id, jobs: count }))
    .sort((a, b) => compareTuples([-a.jobs, a.id], [-b.jobs, b.id]));
  return { ...board, runs };
}

/** The most places a box of places is given when its capacity is known. */
export const MOST_PLACES = 64;

/** Returns a new, empty memory of what the board has shown. */
export function newSteadiness(): Steadiness {
  return { pools: [], places: new Map(), counts: new Map() };
}

/** Returns whether `memory` remembers a pool or box that `board` lacks. */
export function remembersMore(memory: Steadiness, board: Board): boolean {
  return memory.pools.some((pool) => {
    const current = board.pools.find((candidate) => candidate.id === pool.id);
    return current === undefined ||
      pool.boxes.some((box) => !current.boxes.some((candidate) => candidate.id === box.id));
  });
}

/** Forgets the pools and boxes of `memory` that `board` lacks, and their places. */
export function forgetBeyond(memory: Steadiness, board: Board): void {
  for (const key of [...memory.counts.keys()]) {
    const [pool, box] = key.split("\n");
    const current = board.pools.find((candidate) => candidate.id === pool);
    if (!current?.boxes.some((candidate) => candidate.id === box)) memory.counts.delete(key);
  }
  memory.pools = memory.pools.flatMap((pool) => {
    const current = board.pools.find((candidate) => candidate.id === pool.id);
    if (current === undefined) return [];
    return [{
      ...pool,
      boxes: pool.boxes.filter((box) => current.boxes.some((candidate) => candidate.id === box.id)),
    }];
  });
}

/**
 * Returns `board` as it was last shown, as far as it can be: pools and boxes
 * where they were, empty if their jobs have gone, those that are new after
 * them; and each box that is not a machine's given numbered places, as many
 * as its capacity, up to `MOST_PLACES`, or else as many as it has needed,
 * each job in the place it had, or else the first free one, or else a new one
 * at the end. A job that finishes leaves its place empty. Updates `memory`.
 */
export function steadyBoard(board: Board, memory: Steadiness): Board {
  const emptyBox = (box: Box): Box => ({
    ...box,
    jobs: [],
    slots: box.slots?.map((slot) => ({ ...slot, job: null })) ?? null,
  });
  const emptyPool = (pool: Pool): Pool => ({ ...pool, queue: [], boxes: pool.boxes.map(emptyBox) });
  const remembered = [...memory.pools];
  for (const pool of board.pools) {
    const index = remembered.findIndex((candidate) => candidate.id === pool.id);
    if (index < 0) {
      remembered.push(emptyPool(pool));
      continue;
    }
    const boxes = [...remembered[index].boxes];
    for (const box of pool.boxes) {
      if (!boxes.some((candidate) => candidate.id === box.id)) boxes.push(emptyBox(box));
    }
    remembered[index] = { ...emptyPool(pool), boxes };
  }
  memory.pools = remembered;
  const pools = remembered.map((past) => {
    const pool = board.pools.find((candidate) => candidate.id === past.id);
    if (pool === undefined) return past;
    return {
      ...pool,
      boxes: past.boxes.map((box) => pool.boxes.find((candidate) => candidate.id === box.id) ?? box),
    };
  });
  const places = new Map<string, number>();
  const steadied = pools.map((pool) => ({
    ...pool,
    boxes: pool.boxes.map((box): Box => {
      if (box.slots !== null) return box;
      const boxKey = `${pool.id}\n${box.id}`;
      const fixed = box.capacity !== null && box.capacity <= MOST_PLACES ? box.capacity : null;
      const count = fixed ?? memory.counts.get(boxKey) ?? 0;
      if (count === 0 && box.jobs.length === 0) return box;
      const taken: (Token | null)[] = new Array(count).fill(null);
      const unplaced: Token[] = [];
      for (const job of box.jobs) {
        const place = memory.places.get(`${boxKey}\n${job.id}`);
        if (place !== undefined && place < count && taken[place] === null) taken[place] = job;
        else unplaced.push(job);
      }
      const overflow: Token[] = [];
      for (const job of unplaced) {
        const free = taken.indexOf(null);
        if (free >= 0) taken[free] = job;
        else if (fixed === null) taken.push(job);
        else overflow.push(job);
      }
      taken.forEach((job, place) => {
        if (job) places.set(`${boxKey}\n${job.id}`, place);
      });
      if (fixed === null) memory.counts.set(boxKey, taken.length);
      return {
        ...box,
        slots: taken.map((job, place) => ({
          id: `${boxKey}#${place}`,
          name: `${pool.title} place ${place + 1}`,
          label: "",
          online: true,
          job,
          place: true,
        })),
        jobs: overflow,
      };
    }),
  }));
  memory.places = places;
  return { ...board, pools: steadied };
}

/**
 * The colors runs are told apart by: twelve strong ones, each far from the
 * others, then a paler shade of each, taken only when the strong ones are all
 * in use.
 */
export const RUN_COLORS = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#bcbd22",
  "#17becf",
  "#393b79",
  "#e7ba52",
  "#7b4173",
  "#aec7e8",
  "#ffbb78",
  "#98df8a",
  "#ff9896",
  "#c5b0d5",
  "#c49c94",
  "#f7b6d2",
  "#dbdb8d",
  "#9edae5",
  "#9c9ede",
  "#e7cb94",
  "#de9ed6",
];

/** Returns a number for `text` that is the same everywhere: FNV-1a's. */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Says which of `RUN_COLORS` each run on the board is shown in. A run keeps
 * its color while it is on the board. One that comes onto it takes the
 * strong color its ID hashes to, or, when another run on the board has that
 * one, the next that none has, while there is one, strong ones first, those
 * with the most jobs choosing first.
 */
export class RunPalette {
  #colors = new Map<string, number>();

  /** Forgets the runs not in `runs`, and gives each new one a color. */
  update(runs: readonly BoardRun[]): void {
    const present = new Set(runs.map((run) => run.id));
    for (const id of [...this.#colors.keys()]) {
      if (!present.has(id)) this.#colors.delete(id);
    }
    const strong = 12;
    for (const run of runs) {
      if (this.#colors.has(run.id)) continue;
      const taken = new Set(this.#colors.values());
      const preferred = stableHash(run.id) % strong;
      let chosen = preferred;
      for (let i = 0; i < RUN_COLORS.length; i++) {
        const candidate = i < strong ? (preferred + i) % strong : i;
        if (!taken.has(candidate)) {
          chosen = candidate;
          break;
        }
      }
      this.#colors.set(run.id, chosen);
    }
  }

  /** Returns the color of run `id`. */
  color(id: string): string {
    return RUN_COLORS[this.#colors.get(id) ?? stableHash(id) % RUN_COLORS.length];
  }
}

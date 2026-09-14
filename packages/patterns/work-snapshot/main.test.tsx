/**
 * Pattern test for the work snapshot: publish replaces the snapshot whole and
 * validates its shape, a pin adds a pull request the job did not place (a
 * repeated pin changes nothing, and a pinned merged pull request stays
 * merged), a rename shows in the derived workstreams, both survive the next
 * publish, publish, pin, and rename refuse what they cannot trust (a link
 * that is not http(s) among them) and change nothing, and a stored link that
 * is not http(s) renders as text rather than an anchor.
 */
import {
  action,
  assert,
  Default,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findNode, hasText, propValue } from "../test/vnode-helpers.ts";
import Snapshot, {
  type Pin,
  type Rename,
  WORK_SNAPSHOT_SCHEMA,
  type WorkSnapshot,
} from "./main.tsx";

const first: WorkSnapshot = {
  schema: WORK_SNAPSHOT_SCHEMA,
  repository: "commontoolsinc/labs",
  window: { since: "2026-08-28", until: "2026-09-11" },
  generatedAt: "2026-09-11T20:00:00.000Z",
  people: [{ name: "Berni", login: "seefeldb" }],
  workstreams: [{
    id: "board-load",
    name: "Board-load performance",
    summary: "Making the Topics board fast enough to live in.",
    people: ["seefeldb"],
    topics: [{
      title: "Board-load pre-sync follow-ups",
      url: "https://estuary.example/of:fid1:topic",
    }],
    prs: [{
      repo: "commontoolsinc/labs",
      number: 6785,
      title: "keep a corpus's decoded documents resident",
      state: "merged",
      url: "https://github.com/commontoolsinc/labs/pull/6785",
      updatedAt: "2026-09-03T00:00:00.000Z",
      mergedAt: "2026-09-03T00:00:00.000Z",
    }],
  }],
};

const second: WorkSnapshot = {
  ...first,
  generatedAt: "2026-09-12T06:00:00.000Z",
  workstreams: [{
    ...first.workstreams[0],
    summary: "The board loads in 4.5 s; the residual is naming waves.",
  }],
};

/** Snapshots publish refuses: a foreign schema, a blank repository, a
 * workstream without an id, and two workstreams sharing one; workstreams that
 * are not an array reach the verb as no event at all, which it refuses too.
 * Assembled by patching, since no literal carries those shapes under the
 * snapshot's type. */
const MALFORMED: WorkSnapshot[] = [
  { schema: "not-a-snapshot" },
  { repository: "  " },
  { workstreams: "none" },
  { workstreams: [{ ...second.workstreams[0], id: "" }] },
  { workstreams: [second.workstreams[0], second.workstreams[0]] },
  {
    workstreams: [{
      ...second.workstreams[0],
      topics: [{ title: "Unsafe", url: "javascript:alert(1)" }],
    }],
  },
].map((patch) => Object.assign({}, second, patch));

/** A snapshot as an earlier writer could have stored it, carrying a link the
 * publish guard now refuses. */
const LEGACY: WorkSnapshot = {
  ...second,
  workstreams: [{
    ...second.workstreams[0],
    topics: [{ title: "Legacy link", url: "javascript:alert(1)" }],
  }],
};

export default pattern(() => {
  const snapshot = new Writable<WorkSnapshot | Default<WorkSnapshot>>({
    schema: WORK_SNAPSHOT_SCHEMA,
    repository: "",
    window: { since: "", until: "" },
    generatedAt: "",
    people: [],
    workstreams: [],
  });
  const pins = new Writable<Pin[] | Default<[]>>([]);
  const renames = new Writable<Rename[] | Default<[]>>([]);
  const piece = Snapshot({ snapshot, pins, renames });

  const assert_empty = assert(() =>
    piece[NAME] === "Workstreams (empty)" && piece.workstreams.length === 0
  );

  const action_publish = action(() => {
    piece.publish.send({ snapshot: first });
  });
  const assert_published = assert(() =>
    piece[NAME] === "Workstreams: commontoolsinc/labs" &&
    piece.workstreams.length === 1 &&
    piece.workstreams[0]?.name === "Board-load performance" &&
    piece.workstreams[0]?.prs.length === 1 &&
    piece.people[0]?.login === "seefeldb"
  );

  const action_pin_and_rename = action(() => {
    piece.pin.send({
      workstreamId: "board-load",
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/6844",
      title: "Flip the server-execution default back to ON",
      state: "open",
    });
    // A second pin of the same URL changes nothing, not even the title.
    piece.pin.send({
      workstreamId: "board-load",
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/6844",
      state: "open",
    });
    // A pinned merged pull request stays merged rather than counting open.
    piece.pin.send({
      workstreamId: "board-load",
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/7380",
      title: "a start command",
      state: "merged",
    });
    piece.rename.send({ workstreamId: "board-load", name: "Board load" });
  });
  const assert_pinned = assert(() =>
    piece.workstreams[0]?.name === "Board load" &&
    piece.workstreams[0]?.prs.length === 3 &&
    piece.workstreams[0]?.prs[1]?.number === 6844 &&
    piece.workstreams[0]?.prs[1]?.repo === "commontoolsinc/labs" &&
    piece.workstreams[0]?.prs[1]?.state === "open" &&
    piece.workstreams[0]?.prs[2]?.number === 7380 &&
    piece.workstreams[0]?.prs[2]?.state === "merged" &&
    pins.get().length === 2 &&
    pins.get()[0]?.title === "Flip the server-execution default back to ON"
  );

  // The next snapshot replaces the job's part; the pin and rename stay.
  const action_republish = action(() => {
    piece.publish.send({ snapshot: second });
  });
  const assert_republished = assert(() =>
    piece.generatedAt === "2026-09-12T06:00:00.000Z" &&
    piece.workstreams[0]?.summary.startsWith("The board loads") &&
    piece.workstreams[0]?.name === "Board load" &&
    piece.workstreams[0]?.prs.length === 3
  );

  const action_unpin = action(() => {
    piece.unpin.send({
      workstreamId: "board-load",
      url: "https://github.com/commontoolsinc/labs/pull/6844",
    });
  });
  const assert_unpinned = assert(() =>
    piece.workstreams[0]?.prs.length === 2 &&
    piece.workstreams[0]?.prs[1]?.number === 7380 &&
    pins.get().length === 1
  );

  // publish refuses each malformed snapshot and leaves the piece as it was.
  const action_publish_refused = action(() => {
    for (const snapshot of MALFORMED) piece.publish.send({ snapshot });
  });
  const assert_publish_refused = assert(() =>
    piece.generatedAt === "2026-09-12T06:00:00.000Z" &&
    piece.workstreams.length === 1 &&
    piece.workstreams[0]?.prs.length === 2
  );

  // pin and rename refuse a call missing what they key by, and pin refuses a
  // link that is not http(s) and a pull request without its state.
  const action_pin_rename_refused = action(() => {
    piece.pin.send({
      workstreamId: "",
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/1",
      state: "open",
    });
    piece.pin.send({
      workstreamId: "board-load",
      kind: "topic",
      url: "javascript:alert(1)",
      title: "Unsafe",
    });
    // A pull request pin without its state is refused: its state decides
    // whether it counts as open.
    piece.pin.send({
      workstreamId: "board-load",
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/2",
      title: "Stateless",
    });
    piece.rename.send({ workstreamId: "board-load", name: "  " });
  });
  const assert_pin_rename_refused = assert(() =>
    pins.get().length === 1 && piece.workstreams[0]?.name === "Board load"
  );

  // A stored link the guard would refuse renders as text, not an anchor.
  const action_store_legacy = action(() => {
    snapshot.set(LEGACY);
  });
  const assert_legacy_rendered_as_text = assert(() =>
    findNode(
        piece[UI],
        (node) => propValue(node, "href") === "javascript:alert(1)",
      ) === undefined && hasText(piece[UI], "Legacy link")
  );

  return {
    [NAME]: "Work snapshot test",
    [UI]: piece[UI],
    // The ten refused calls above each throw inside their verb, which the
    // runner reports as runtime errors; exactly ten are expected.
    expectRuntimeErrors: 10,
    [TESTS]: [
      { assertion: assert_empty },
      { action: action_publish },
      { assertion: assert_published },
      { render: piece[UI] },
      { action: action_pin_and_rename },
      { assertion: assert_pinned },
      { action: action_republish },
      { assertion: assert_republished },
      { action: action_unpin },
      { assertion: assert_unpinned },
      { action: action_publish_refused },
      { assertion: assert_publish_refused },
      { action: action_pin_rename_refused },
      { assertion: assert_pin_rename_refused },
      { action: action_store_legacy },
      { assertion: assert_legacy_rendered_as_text },
    ],
  };
});

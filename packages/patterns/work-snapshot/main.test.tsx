/**
 * Pattern test for the work snapshot: publish replaces the snapshot whole and
 * validates its shape, a pin adds a pull request the job did not place, a
 * rename shows in the derived workstreams, and both survive the next publish.
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
    });
    // A second pin of the same URL is a no-op.
    piece.pin.send({
      workstreamId: "board-load",
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/6844",
    });
    piece.rename.send({ workstreamId: "board-load", name: "Board load" });
  });
  const assert_pinned = assert(() =>
    piece.workstreams[0]?.name === "Board load" &&
    piece.workstreams[0]?.prs.length === 2 &&
    piece.workstreams[0]?.prs[1]?.number === 6844 &&
    piece.workstreams[0]?.prs[1]?.repo === "commontoolsinc/labs" &&
    pins.get().length === 1
  );

  // The next snapshot replaces the job's part; the pin and rename stay.
  const action_republish = action(() => {
    piece.publish.send({ snapshot: second });
  });
  const assert_republished = assert(() =>
    piece.generatedAt === "2026-09-12T06:00:00.000Z" &&
    piece.workstreams[0]?.summary.startsWith("The board loads") &&
    piece.workstreams[0]?.name === "Board load" &&
    piece.workstreams[0]?.prs.length === 2
  );

  const action_unpin = action(() => {
    piece.unpin.send({
      workstreamId: "board-load",
      url: "https://github.com/commontoolsinc/labs/pull/6844",
    });
  });
  const assert_unpinned = assert(() =>
    piece.workstreams[0]?.prs.length === 1 && pins.get().length === 0
  );

  return {
    [NAME]: "Work snapshot test",
    [UI]: piece[UI],
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
    ],
  };
});

/**
 * Pattern test for the work snapshot: publish replaces the snapshot whole and
 * validates its shape, a pin adds a pull request the job did not place (a
 * repeated pin changes nothing, and a pinned merged pull request stays
 * merged), the newest rename names the workstream, both survive the next
 * publish, unpin clears the record so a later pin of the same URL starts
 * fresh, a pin and a rename whose workstream a later snapshot drops are
 * listed as orphaned and return with it, publish, pin, and rename refuse what
 * they cannot trust (a link that is not http(s), a pull request pin that is
 * not a GitHub pull request URL, a padded workstream id, and a workstream the
 * snapshot lacks among them) and change nothing, and a stored link that is not http(s)
 * renders as text rather than an anchor.
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
  type PullRequestPinEvent,
  type Rename,
  WORK_SNAPSHOT_SCHEMA,
  type WorkSnapshot,
} from "./main.tsx";

/** A pin as a caller outside the type could spell it: the type requires a
 * pull request pin's state, the boundary does not enforce it, so the verb's
 * own check is reached through this looser shape. */
interface LoosePinEvent {
  workstreamId: string;
  kind: string;
  url: string;
  title?: string;
  state?: string;
}

const STATELESS_PIN: LoosePinEvent = {
  workstreamId: "board-load",
  kind: "pr",
  url: "https://github.com/commontoolsinc/labs/pull/2",
  title: "Stateless",
};

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
 * workstream without an id, two workstreams sharing one, an id with
 * surrounding whitespace, and two ids differing only by it; workstreams that
 * are not an array reach the verb as no event at all, which it refuses too.
 * Assembled by patching, since no literal carries those shapes under the
 * snapshot's type. */
const MALFORMED: WorkSnapshot[] = [
  { schema: "not-a-snapshot" },
  { repository: "  " },
  { workstreams: "none" },
  { workstreams: [{ ...second.workstreams[0], id: "" }] },
  { workstreams: [second.workstreams[0], second.workstreams[0]] },
  // Padded: an id pins and renames could never name, and one that would
  // pass as distinct from its trimmed twin.
  { workstreams: [{ ...second.workstreams[0], id: " board-load " }] },
  {
    workstreams: [
      second.workstreams[0],
      { ...second.workstreams[0], id: " board-load " },
    ],
  },
  {
    // Its own generatedAt: were the link guard gone, this snapshot would
    // land and the piece would show this time.
    generatedAt: "2026-09-13T00:00:00.000Z",
    workstreams: [{
      ...second.workstreams[0],
      topics: [{ title: "Unsafe", url: "javascript:alert(1)" }],
    }],
  },
].map((patch) => Object.assign({}, second, patch));

/** A later snapshot that carries a different workstream, so pins and renames
 * on the first one are orphaned. */
const THIRD: WorkSnapshot = {
  ...second,
  generatedAt: "2026-09-14T06:00:00.000Z",
  workstreams: [{ ...second.workstreams[0], id: "other", name: "Other" }],
};

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
  const snapshot = new Writable<WorkSnapshot>({
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
    // Two renames; the newest names the workstream.
    piece.rename.send({ workstreamId: "board-load", name: "Board loading" });
    piece.rename.send({ workstreamId: "board-load", name: "Board load" });
  });
  const assert_pinned = assert(() =>
    piece.workstreams[0]?.name === "Board load" &&
    renames.get().length === 2 &&
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
  const action_repin = action(() => {
    piece.pin.send({
      workstreamId: "board-load",
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/6844",
      title: "Flipped, and merged since",
      state: "merged",
    });
  });
  const assert_repinned_fresh = assert(() =>
    piece.workstreams[0]?.prs.length === 3 &&
    piece.workstreams[0]?.prs[2]?.number === 6844 &&
    piece.workstreams[0]?.prs[2]?.title === "Flipped, and merged since" &&
    piece.workstreams[0]?.prs[2]?.state === "merged" &&
    pins.get().length === 2
  );

  // A snapshot that drops the workstream leaves its pins and rename listed
  // as orphaned rather than lost; the next one that carries it brings them
  // back.
  const action_publish_other = action(() => {
    piece.publish.send({ snapshot: THIRD });
  });
  const assert_orphaned_overlay = assert(() =>
    piece.workstreams.length === 1 &&
    piece.workstreams[0]?.id === "other" &&
    piece.workstreams[0]?.prs.length === 1 &&
    piece.orphanedPins.length === 2 &&
    piece.orphanedRenames.length === 2 &&
    hasText(piece[UI], "Pinned or renamed on work no longer shown") &&
    hasText(piece[UI], "workstream board-load · https://github.com") &&
    hasText(piece[UI], 'workstream board-load renamed "Board load"')
  );
  const action_publish_second_again = action(() => {
    piece.publish.send({ snapshot: second });
  });
  const assert_overlay_returns = assert(() =>
    piece.orphanedPins.length === 0 &&
    piece.orphanedRenames.length === 0 &&
    piece.workstreams[0]?.name === "Board load" &&
    piece.workstreams[0]?.prs.length === 3
  );

  // publish refuses each malformed snapshot and leaves the piece as it was.
  const action_publish_refused = action(() => {
    for (const snapshot of MALFORMED) piece.publish.send({ snapshot });
  });
  const assert_publish_refused = assert(() =>
    piece.generatedAt === "2026-09-12T06:00:00.000Z" &&
    piece.workstreams.length === 1 &&
    piece.workstreams[0]?.prs.length === 3
  );

  // pin and rename refuse a call missing what they key by or naming a
  // workstream the snapshot lacks, and pin refuses a link that is not http(s)
  // and a pull request without its state.
  const action_pin_rename_refused = action(() => {
    piece.pin.send({
      workstreamId: "typo",
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/3",
      title: "pinned to a typo",
      state: "open",
    });
    piece.rename.send({ workstreamId: "typo", name: "Renamed typo" });
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
    piece.pin.send(STATELESS_PIN as PullRequestPinEvent);
    // A pull request pin whose URL is not a GitHub pull request is refused,
    // http(s) though it is: there is no repository and number to read.
    piece.pin.send({
      workstreamId: "board-load",
      kind: "pr",
      url: "https://example.com/not-a-pr",
      title: "Not a pull request",
      state: "open",
    });
    piece.rename.send({ workstreamId: "board-load", name: "  " });
  });
  const assert_pin_rename_refused = assert(() =>
    pins.get().length === 2 && renames.get().length === 2 &&
    piece.workstreams[0]?.name === "Board load" &&
    piece.orphanedPins.length === 0 && piece.orphanedRenames.length === 0
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
    // The fifteen refused calls above each throw inside their verb, which the
    // runner reports as runtime errors; exactly fifteen are expected.
    expectRuntimeErrors: 15,
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
      { action: action_repin },
      { assertion: assert_repinned_fresh },
      { action: action_publish_other },
      { render: piece[UI] },
      { assertion: assert_orphaned_overlay },
      { action: action_publish_second_again },
      { assertion: assert_overlay_returns },
      { action: action_publish_refused },
      { assertion: assert_publish_refused },
      { action: action_pin_rename_refused },
      { assertion: assert_pin_rename_refused },
      { action: action_store_legacy },
      { assertion: assert_legacy_rendered_as_text },
    ],
  };
});

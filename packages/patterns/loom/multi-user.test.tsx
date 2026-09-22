/** Independent sessions compose one shared collection and one participant roster through concurrent actions. */
import {
  action,
  assert,
  type Cell,
  type Confidential,
  multiUserTest,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { clickButton, hasText } from "../test/vnode-helpers.ts";
import Loom from "./main.tsx";
import type { LoomOutput, Panel } from "./schemas.tsx";

type TestProfile = Confidential<
  { name?: string; avatar?: string },
  readonly ["loom-test-profile"]
>;

interface Handoff {
  profile?: Cell<TestProfile>;
}

interface Setup {
  loom: LoomOutput;
  // Where one session puts a profile for another to add: the owner adding a
  // recipient's profile is a profile its own session did not create.
  handoff: Writable<Handoff>;
}
export const setup = pattern(() => ({
  loom: Loom({}),
  handoff: Writable.of<Handoff>({}),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const panel = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/alice",
  });
  const add = action(() => setup.loom.addPanel.send({ panel }));
  const select = action(() =>
    setup.loom.viewerState.set({ selectedPanel: panel })
  );
  const stage = action(() => clickButton(setup.loom[UI], "Stage all"));
  // Labeled, as a real profile is: the runtime links only a document whose
  // label it holds into the write-protected roster.
  const profile = Writable.of<TestProfile>({
    name: "Alice",
  });
  const join = action(() => setup.loom.addParticipant.send({ profile }));
  // A second profile Alice never adds herself; Bob adds it.
  const work = Writable.of<TestProfile>({ name: "Alice at work" });
  const handOff = action(() => setup.handoff.set({ profile: work }));
  return {
    [TESTS]: [
      { action: add },
      { action: select },
      { label: "alice-added" },
      { await: "bob-added" },
      { assertion: assert(() => setup.loom.panels.length === 2) },
      {
        assertion: assert(() =>
          setup.loom.viewerState.key("selectedPanel").equals(panel)
        ),
      },
      { render: setup.loom[UI] },
      { action: stage },
      { label: "alice-staged" },
      { render: setup.loom[UI] },
      {
        assertion: assert(() =>
          hasText(setup.loom[UI], "Staged for everyone") &&
          !hasText(setup.loom[UI], "Not staged")
        ),
      },
      {
        assertion: assert(() =>
          setup.loom.presentation.stagedPanels.length === 2
        ),
      },
      { action: join },
      { action: join },
      { label: "alice-joined" },
      { action: handOff },
      { label: "alice-handed" },
      // The adding session converges to one entry per profile too.
      { await: "tab2-counted" },
      { assertion: assert(() => setup.loom.participants.length === 3) },
      { await: "bob-joined" },
      // The adding session's own view can briefly hold its optimistic adds
      // on top of the merged roster, so the count is asserted by the other
      // sessions; this one checks it is listed.
      {
        assertion: assert(() =>
          setup.loom.participants.some((entry) => entry.equals(profile))
        ),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const panel = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/bob",
  });
  const add = action(() => setup.loom.addPanel.send({ panel }));
  const select = action(() =>
    setup.loom.viewerState.set({ selectedPanel: panel })
  );
  // Labeled, as a real profile is: the runtime links only a document whose
  // label it holds into the write-protected roster.
  const profile = Writable.of<TestProfile>({
    name: "Bob",
  });
  const join = action(() => setup.loom.addParticipant.send({ profile }));
  const addOther = action(() => {
    const other = setup.handoff.get().profile;
    if (other) setup.loom.addParticipant.send({ profile: other });
  });
  return {
    [TESTS]: [
      { action: add },
      { action: select },
      { label: "bob-added" },
      { await: "alice-added" },
      { assertion: assert(() => setup.loom.panels.length === 2) },
      {
        assertion: assert(() =>
          setup.loom.viewerState.key("selectedPanel").equals(panel)
        ),
      },
      { await: "alice-staged" },
      {
        assertion: assert(() =>
          setup.loom.presentation.stagedPanels.length === 2
        ),
      },
      { action: join },
      { label: "bob-joined" },
      { await: "alice-joined" },
      {
        assertion: assert(() =>
          setup.loom.participants.length === 2 &&
          setup.loom.participants.some((entry) => entry.equals(profile))
        ),
      },
      // Bob links a profile another principal created and never added.
      { await: "alice-handed" },
      { action: addOther },
      { label: "bob-added-other" },
    ],
  };
});

export const aliceTab2 = pattern<{ setup: Setup }>(({ setup }) => {
  const panel = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/second-tab",
  });
  const select = action(() =>
    setup.loom.viewerState.set({ selectedPanel: panel })
  );
  return {
    [TESTS]: [
      { action: select },
      { await: "alice-added" },
      { await: "bob-added" },
      {
        assertion: assert(() =>
          setup.loom.viewerState.key("selectedPanel").equals(panel)
        ),
      },
      // Alice added her profile twice and Bob once: one entry each.
      { await: "alice-joined" },
      { await: "bob-joined" },
      // Alice's own profile once, Bob's, and the one Bob added for Alice.
      { await: "bob-added-other" },
      { assertion: assert(() => setup.loom.participants.length === 3) },
      { label: "tab2-counted" },
      { render: setup.loom[UI] },
      { assertion: assert(() => hasText(setup.loom[UI], "Stage all")) },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    aliceTab2: { pattern: aliceTab2, user: "alice" },
  },
});

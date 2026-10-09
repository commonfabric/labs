import { equals, handler, lift, Writable } from "commonfabric";

interface Panel {
  name: string;
}

type PanelEvent = { panel: Writable<Panel> };
type Selection = {
  selected: Writable<Panel | undefined>;
  unused: Writable<Panel>;
};

const compareMember = handler<PanelEvent, Selection>((event, state) => {
  if (equals(state.selected, event.panel)) return;
});

const compareDestructured = handler<PanelEvent, Selection>(
  (event, { selected }) => {
    if (equals(selected, event.panel)) return;
  },
);

const compareMemberAsMethodArgument = handler<PanelEvent, Selection>(
  (event, state) => {
    if (event.panel.equals(state.selected)) return;
  },
);

const compareMemberInLift = lift((
  { state, other }: { state: Selection; other: Writable<Panel> },
) => equals(state.selected, other));

// FIXTURE: identity-member-argument
// Verifies: a member handed to a known identity call is compared, not read,
// so it is a comparable cell as a destructured binding compared the same way
// is, and in every spelling the state's unused member is pruned.
export {
  compareDestructured,
  compareMember,
  compareMemberAsMethodArgument,
  compareMemberInLift,
};

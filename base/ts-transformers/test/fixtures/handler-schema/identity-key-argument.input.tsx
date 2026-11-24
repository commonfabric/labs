import {
  computed,
  equalsKey,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

interface Panel {
  name: string;
}

type PanelEvent = { panel: Writable<Panel> };
type Selection = {
  selected: Writable<Panel | undefined>;
  unused: Writable<Panel>;
};

const keyMember = handler<PanelEvent, Selection>((event, state) => {
  if (equalsKey(state.selected) === equalsKey(event.panel)) return;
});

const keyMemberInLift = lift((
  { state, other }: { state: Selection; other: Writable<Panel> },
) => equalsKey(state.selected) === equalsKey(other));

// FIXTURE: identity-key-argument
// Verifies: a value handed to `equalsKey` is compared, not read, as one handed
// to `equals` is, so it is a comparable cell: a member and a list's elements
// alike, and the state's unused member is pruned.
export default pattern<{ panels: Writable<Panel[]>; picked: Writable<Panel> }>(
  ({ panels, picked }) => {
    const others = computed(() =>
      panels.get().filter((panel) => equalsKey(panel) !== equalsKey(picked))
        .length
    );
    return { others };
  },
);

export { keyMember, keyMemberInLift };

import { computed, pattern, UI, Writable } from "commonfabric";

interface TagEvent {
  label: string;
}

interface Item {
  name: string;
  value: number;
}

type State = {
  user: {
    settings: {
      notifications: boolean;
    };
  };
  recentEvents: TagEvent[];
  items: Item[];
};

// FIXTURE: ternary-branch-ownership
// Verifies: ternary branches preserve the right ownership mode for lowered work
//   state.user.settings.notifications ? "enabled" : "disabled"
//     -> ifElse(...) with a boolean predicate schema after key(...) lowering
//   recentEvents.length === 0 ? <span>... : <div>{recentEvents.map(...)}</div>
//     -> single branch lift-applied computation + recentEvents.mapWithPattern(...)
//   showList ? (() => { const itemCount = count + " items"; return <div>{sorted.map(...)}</div>; })() : ...
//     -> whole branch compute-wrapped, so sorted.map(...) stays plain JS
export default pattern<State>((state) => {
  const showList = new Writable(true);
  const sorted = computed(() =>
    [...state.items].sort((a, b) => a.value - b.value)
  );
  const count = computed(() => state.items.length);

  return {
    [UI]: (
      <div>
        <p>{state.user.settings.notifications ? "enabled" : "disabled"}</p>
        {state.recentEvents.length === 0
          ? <span>No events yet</span>
          : (
            <div>
              {state.recentEvents.map((event: TagEvent, idx: number) => (
                <cf-hstack key={idx} gap="2">
                  <span>{event.label}</span>
                </cf-hstack>
              ))}
            </div>
          )}
        {showList
          ? (() => {
            const itemCount = count + " items";
            return (
              <div>
                <span>{itemCount}</span>
                {sorted.map((item: Item) => (
                  <span>{item.name}</span>
                ))}
              </div>
            );
          })()
          : <span>Hidden</span>}
      </div>
    ),
  };
});

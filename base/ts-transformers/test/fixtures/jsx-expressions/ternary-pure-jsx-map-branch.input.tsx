import { pattern, UI } from "commonfabric";

interface TagEvent {
  label: string;
}

// FIXTURE: ternary-pure-jsx-map-branch
// Verifies: a plain reactive array map inside a ternary JSX branch stays
// pattern-lowered without wrapping the whole branch in extra lift-applied noise.
//   recentEvents.length === 0 ? <span>...</span> : <div>{recentEvents.map(...)}</div>
//     → ifElse(lift(...)(length===0), <span>...</span>, <div>{recentEvents.mapWithPattern(...)}</div>)
// Context: implicit JSX ternary branch selection with a pure pattern-owned map
//   in the false branch.
export default pattern<{ recentEvents: TagEvent[] }>(({ recentEvents }) => ({
  [UI]: (
    <div>
      {recentEvents.length === 0
        ? <span>No events yet</span>
        : (
          <div>
            {recentEvents.map((event: TagEvent, idx: number) => (
              <cf-hstack key={idx} gap="2">
                <span>{event.label}</span>
              </cf-hstack>
            ))}
          </div>
        )}
    </div>
  ),
}));

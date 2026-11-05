// deno-lint-ignore-file no-unused-vars
import { handler, computed } from "commonfabric";

// FIXTURE: safe-context-and-jsx
// Verifies: && and || with JSX inside handler callbacks are transformed to when()/unless()
//   computed(() => show) && <span> → when(computed(() => show), <span>)
//   computed(() => value) || <span> → unless(computed(() => value), <span>)
// Context: Ensures transforms work in handler context, not just pattern context

// Test: && with JSX inside handler callback should transform to when()
const MyHandler = handler<Event, { show: boolean }>((_event, { show }) => {
  return <div>{computed(() => show) && <span>Content</span>}</div>;
});

// Test: || with JSX inside handler callback should transform to unless()
const MyHandler2 = handler<Event, { value: string | null }>((_event, { value }) => {
  return <div>{computed(() => value) || <span>Fallback</span>}</div>;
});

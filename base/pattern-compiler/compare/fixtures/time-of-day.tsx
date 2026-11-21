/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

// A handler that reads the time of day and draws from `Math.random` and
// from `crypto.randomUUID` to name a member it appends. The comparison
// gives the value code one time of day for each event and seeds what it
// draws (`compare/random.ts`), so two runs of one scenario hold the same
// values.
type Message = { id: string; uuid: string; at: number; day: string };

const post = handler<unknown, { messages: Writable<Message[]> }>(
  (_, { messages }) => {
    messages.push({
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      uuid: crypto.randomUUID(),
      at: Date.now(),
      day: new Date().toISOString().slice(0, 10),
    });
  },
);

export default pattern<{ note: string }>(({ note }) => {
  const messages = Writable.of<Message[]>([]);
  return { note, messages, post: post({ messages }) };
});

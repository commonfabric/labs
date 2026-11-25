/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type ReadonlyCell,
  type Stream,
  Writable,
} from "commonfabric";

// A FabriChat send reduced to what its commit prepares: the handler of
// `send` reads a value of another space, which carries a label of its own
// and which the piece derives its `name` from, as a room derives from the
// sender's profile; it appends the event's text, and sends
// `{ messageAct: true }` to the stream `tell` of the same piece, whose
// handler counts the acts. The append of that event goes into the event log
// of `tell` in the transaction of `send`.

interface Told {
  messageAct?: boolean;
}

const told = handler<Told, { acts: Writable<number> }>((event, { acts }) => {
  if (event?.messageAct === true) acts.set(acts.get() + 1);
});

const send = handler<
  { text: string },
  {
    secret: ReadonlyCell<{ name?: string }>;
    joined: Stream<Told>;
    sent: Writable<string[]>;
  }
>((event, { secret, joined, sent }) => {
  if (!secret.get()?.name) throw new Error("No name to send under.");
  sent.push(event.text);
  joined.send({ messageAct: true });
});

interface Output {
  name: string;
  acts: number;
  sent: string[];
  tell: Stream<Told>;
  send: Stream<{ text: string }>;
}

export default pattern<{ secret: ReadonlyCell<{ name?: string }> }, Output>(
  ({ secret }) => {
    const acts = Writable.of(0);
    const sent = Writable.of<string[]>([]);
    const tell = told({ acts });
    const name = computed(() => secret.get()?.name ?? "");
    return {
      name,
      acts,
      sent,
      tell,
      send: send({ secret, joined: tell, sent }),
    };
  },
);

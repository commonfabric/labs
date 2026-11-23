/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

// A pattern that is handed the list and the record of another pattern,
// typed with no write policy, and whose handlers write them: the handlers
// `forgeEntry` and `forgeFrozen` of
// `patterns/dev/test/writer-policy/multi-user.test.tsx` as a pattern of
// their own. The list is an array of plain values in place.

interface Entry {
  seat: number;
  digest: string;
}

const forgeEntry = handler<void, { entries: Writable<Entry[]> }>(
  (_, { entries }) => {
    entries.push({ seat: 99, digest: "forged" });
  },
);

const forgeFrozen = handler<void, { frozen: Writable<Entry> }>(
  (_, { frozen }) => {
    frozen.set({ seat: 99, digest: "forged" });
  },
);

interface Input {
  entries: Writable<Entry[]>;
  frozen: Writable<Entry>;
}

interface Output {
  forgeEntry: Stream<void>;
  forgeFrozen: Stream<void>;
}

export default pattern<Input, Output>(({ entries, frozen }) => ({
  forgeEntry: forgeEntry({ entries }),
  forgeFrozen: forgeFrozen({ frozen }),
}));

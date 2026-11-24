/**
 * Fixture for a trusted gesture that also carries a payload. A real click
 * carries `type: "click"`; a payload adds to that gesture rather than
 * replacing it, so the handler sees both.
 */

import { assert, handler, pattern, TESTS, type Writable } from "commonfabric";

const record = handler<
  { type?: string; name?: string },
  { seen: Writable<string> }
>((event, { seen }) => {
  seen.set(`${event?.type ?? "MISSING"}/${event?.name ?? "MISSING"}`);
});

export default pattern<{ seen: Writable<string> }, { seen: string }>(
  ({ seen }) => ({
    seen,
    [TESTS]: [
      {
        action: record({ seen }),
        event: { name: "Bob" },
        trustedUi: { surface: "Surface", action: "Action" },
      },
      { assertion: assert(() => seen.get() === "click/Bob") },
    ],
  }),
);

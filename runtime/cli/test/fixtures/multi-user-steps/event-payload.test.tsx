/// <cts-enable />

/**
 * An action step's `event` payload in a multi-user run. Alice sends an object
 * payload and asserts on what the handler recorded, so the assertion fails if
 * the orchestrator delivers anything other than what the step authored. An
 * object payload is the case that matters: a primitive one has always arrived.
 */

import {
  assert,
  handler,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

export interface PayloadSetup {
  seen: Writable<string>;
}

export const setup = pattern<Record<string, never>, PayloadSetup>(() => ({
  seen: Writable.of<string>(""),
}));

const record = handler<
  { n?: number; inner?: { label?: string } },
  { seen: Writable<string> }
>((event, { seen }) => {
  seen.set(`${event?.n ?? -1}/${event?.inner?.label ?? ""}`);
});

export const alice = pattern<{ setup: PayloadSetup }>(({ setup }) => ({
  [TESTS]: [
    {
      action: record({ seen: setup.seen }),
      event: { n: 42, inner: { label: "deep" } },
    },
    { assertion: assert(() => setup.seen.get() === "42/deep") },
  ],
}));

export default multiUserTest({ setup, participants: { alice } });

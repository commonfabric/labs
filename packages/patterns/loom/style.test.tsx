/** Two participants read and replace one confirmed style, including clearing it. */

import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";
import Loom from "./main.tsx";
import type { LoomOutput } from "./schemas.tsx";

/** Shared Loom supplied to each participant. */
interface Setup {
  /** One root observed from independent runtimes. */
  loom: LoomOutput;
}

/** Creates an unstyled Loom. */
export const setup = pattern(() => ({ loom: Loom({}) }));

/** Confirms a style, observes a peer's replacement, and clears it. */
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const confirm = action(() =>
    setup.loom.setStyle.send({
      style: { id: "quiet-paper", mode: "dark" },
    })
  );
  const clear = action(() => setup.loom.setStyle.send({ style: null }));
  return {
    [TESTS]: [
      { assertion: assert(() => setup.loom.style === null) },
      { action: confirm },
      { label: "alice-confirmed" },
      { await: "bob-confirmed" },
      { assertion: assert(() => setup.loom.style?.id === "soft-ink") },
      { assertion: assert(() => setup.loom.style?.mode === "light") },
      { action: clear },
      { label: "alice-cleared" },
      { await: "bob-read-clear" },
    ],
  };
});

/** Observes the owner's choice, replaces it, then observes the clear. */
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const confirm = action(() =>
    setup.loom.setStyle.send({
      style: { id: "soft-ink", mode: "light" },
    })
  );
  return {
    [TESTS]: [
      { await: "alice-confirmed" },
      { assertion: assert(() => setup.loom.style?.id === "quiet-paper") },
      { assertion: assert(() => setup.loom.style?.mode === "dark") },
      { action: confirm },
      { label: "bob-confirmed" },
      { await: "alice-cleared" },
      { assertion: assert(() => setup.loom.style === null) },
      { label: "bob-read-clear" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });

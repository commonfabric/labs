/** Invalid catalog identifiers leave the complete confirmed style untouched. */

import { action, assert, pattern, TESTS } from "commonfabric";
import Loom from "./main.tsx";

export default pattern(() => {
  const invalidSeed = Loom({ style: { id: "../outside", mode: "dark" } });
  const loom = Loom({ style: { id: "quiet-paper", mode: "native" } });
  const invalid = action(() =>
    loom.setStyle.send({
      style: { id: "../outside", mode: "dark" },
    })
  );
  const tooLong = action(() =>
    loom.setStyle.send({
      style: { id: "a".repeat(65), mode: "light" },
    })
  );
  const newline = action(() =>
    loom.setStyle.send({ style: { id: "quiet-paper\n", mode: "dark" } })
  );
  return {
    allowRuntimeErrors: true,
    expectRuntimeErrors: 3,
    allowConsoleErrors: true,
    [TESTS]: [
      { assertion: assert(() => invalidSeed.style === null) },
      { assertion: assert(() => loom.style?.id === "quiet-paper") },
      { action: invalid },
      { action: tooLong },
      { action: newline },
      { assertion: assert(() => loom.style?.id === "quiet-paper") },
      { assertion: assert(() => loom.style?.mode === "native") },
    ],
  };
});

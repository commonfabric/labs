/**
 * Who may remove an occurrence whose label does not settle on one adder. Bob,
 * at WRITE, links two occurrences no stamp attributes, and gives one of them
 * a profile outside the root's handlers, so it holds a profile no stamp says
 * anyone acted under. Bob removes the other, which records no adder, but not
 * that one, though he linked it and wrote its profile. Alice, the Loom's
 * OWNER, removes it.
 */
import {
  action,
  assert,
  handler,
  multiUserTest,
  pattern,
  principalsOf,
  TESTS,
  Writable,
} from "commonfabric";
import Loom from "./main.tsx";
import type { LoomOutput, Panel } from "./schemas.tsx";

interface Setup {
  loom: LoomOutput;
  // An occurrence that records no adder, and later holds an unstamped profile.
  profiled: Writable<Panel>;
  // An occurrence that records no adder throughout.
  bare: Writable<Panel>;
}

const PROFILED_URL = "https://example.com/unstamped-profile";
const BARE_URL = "https://example.com/no-adder";

export const setup = pattern(() => ({
  loom: Loom({}),
  profiled: new Writable<Panel>({ kind: "url", url: PROFILED_URL }),
  bare: new Writable<Panel>({ kind: "url", url: BARE_URL }),
}));

/** A panel's profile field, as a writer outside the root's handlers sees it. */
interface ProfileField {
  addedByProfile?: { name?: string };
}

/** Writes `profile` into `panel`'s profile field, which stamps nobody. */
const writeProfileField = handler<
  { panel: Writable<ProfileField> },
  { profile: Writable<{ name?: string }> }
>(({ panel }, { profile }) => {
  panel.key("addedByProfile").set(profile);
});

/** Whether `loom` holds an occurrence showing `url`. */
const holds = (loom: LoomOutput, url: string): boolean =>
  loom.panels.some((panel) => {
    const value = panel?.get();
    return value?.kind === "url" && value.url === url;
  });

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const loom = setup.loom;
  const remove = action(() => loom.removePanel.send({ panel: setup.profiled }));
  return {
    [TESTS]: [
      { await: "bob-refused" },
      { assertion: assert(() => holds(loom, PROFILED_URL)) },
      { action: remove },
      {
        assertion: assert(() =>
          loom.panels.length === 0 && !holds(loom, PROFILED_URL)
        ),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const loom = setup.loom;
  const profile = new Writable<{ name?: string }>({ name: "Bob" });
  const write = writeProfileField({ profile });
  const link = action(() => {
    loom.addPanel.send({ panel: setup.profiled });
    loom.addPanel.send({ panel: setup.bare });
  });
  const giveProfile = action(() => write.send({ panel: setup.profiled }));
  const removeBare = action(() => loom.removePanel.send({ panel: setup.bare }));
  const removeProfiled = action(() =>
    loom.removePanel.send({ panel: setup.profiled })
  );
  return {
    // Removing the profiled occurrence is refused, and reported as a runtime
    // error.
    allowRuntimeErrors: true,
    expectRuntimeErrors: 1,
    [TESTS]: [
      { action: link },
      { action: giveProfile },
      {
        assertion: assert(() =>
          loom.panels.length === 2 &&
          setup.profiled.key("addedByProfile").equals(profile) &&
          principalsOf(
              setup.profiled.key("addedByProfile"),
              "represents-principal",
              { label: "written" },
            )?.length === 0
        ),
      },
      { action: removeBare },
      {
        assertion: assert(() =>
          loom.panels.length === 1 && !holds(loom, BARE_URL)
        ),
      },
      { action: removeProfiled },
      {
        assertion: assert(() =>
          loom.panels.length === 1 && holds(loom, PROFILED_URL)
        ),
      },
      { label: "bob-refused" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });

import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findNodeByProp, hasText } from "../test/vnode-helpers.ts";
import Home from "./home.tsx";

export default pattern(() => {
  const home = Home({});

  // A stable piece cell to favorite and unfavorite by identity.
  const piece = new Writable<{ [NAME]?: string }>({ [NAME]: "Fav Piece" });

  const assert_initial_profile_missing = assert(() =>
    ((home.profiles as unknown[])?.length ?? 0) === 0
  );

  // The agent queue is held in a field of its own and starts empty, with no
  // runner registered.
  const assert_agent_queue_starts_empty = assert(() =>
    home.agentQueue.entries.get().length === 0 &&
    home.agentQueue.agentRunner === undefined
  );
  const assert_agent_runs_tab = assert(() =>
    hasText(findNodeByProp(home[UI], "value", "agent-runs"), "Agent runs") &&
    hasText(
      findNodeByProp(home[UI], "id", "home-agent-runs"),
      "No runner is registered.",
    ) &&
    hasText(findNodeByProp(home[UI], "value", "self"), "Self")
  );
  const action_register_runner = action(() => {
    home.agentQueue.setAgentRunner.send({
      runner: {
        host: "https://local.example",
        tools: [],
        registrationId: "runner-1",
        registeredAt: "2026-09-18T00:00:00.000Z",
      },
    });
  });
  const assert_runner_registered = assert(() =>
    home.agentQueue.agentRunner?.host === "https://local.example"
  );

  // NOTE: untrusted-write protection (sending the exported `createProfile`
  // stream from outside the trusted ProfileCreate surface must NOT create a
  // profile) is enforced by CFC and verified in
  // packages/runner/test/profile-owner-cfc.test.ts under `enforce-explicit`.
  // It can't be asserted here: the pattern-test runner runs CFC in `observe`
  // mode (no enforcement), so an untrusted send is not blocked. The previous
  // version of this test only "passed" because the untrusted cross-space
  // `inSpace` write incidentally threw a write-isolation error — which the
  // multi-profile change legitimately allows via a multi-space commit.

  // Favorites are keyed by the piece's identity (the client-supplied id): the
  // handler sets the keyed entity and add-uniques it.
  const action_add_favorite = action(() => {
    home.addFavorite.send({
      piece,
      tags: ["demo"],
      spaceName: "space-a",
      id: "fav-1",
    });
  });

  // The first removal takes the keyed path (the entity exists) and clears it.
  const action_remove_favorite = action(() => {
    home.removeFavorite.send({ piece, id: "fav-1" });
  });

  // A second removal with the same id finds no entity (it was cleared), so it
  // takes the piece-cell fallback that keeps a pre-keyed favorite deletable.
  const action_remove_favorite_again = action(() => {
    home.removeFavorite.send({ piece, id: "fav-1" });
  });

  // The journal append is an exported mergeable push.
  const action_add_journal = action(() => {
    home.addJournalEntry.send({
      entry: {
        timestamp: 1,
        eventType: "piece:created",
        space: "space-a",
      },
    });
  });

  // Spaces are keyed by name: the add sets the keyed entity and add-uniques it,
  // and the remove matches that identity via removeByValue.
  const action_add_space = action(() => {
    home.addSpace.send({ detail: { message: "Space One" } });
  });
  const action_remove_space = action(() => {
    home.removeSpace.send({ name: "Space One" });
  });
  const assert_empty_space_notice = assert(() =>
    hasText(home[UI], "No spaces yet. Add one below.")
  );
  const assert_space_notice_hidden = assert(() =>
    !hasText(home[UI], "No spaces yet. Add one below.")
  );

  return {
    [TESTS]: [
      { assertion: assert_initial_profile_missing },
      { assertion: assert_agent_queue_starts_empty },
      { assertion: assert_agent_runs_tab },
      { action: action_register_runner },
      { assertion: assert_runner_registered },
      { action: action_add_favorite },
      { action: action_remove_favorite },
      { action: action_remove_favorite_again },
      { action: action_add_journal },
      { assertion: assert_empty_space_notice },
      { action: action_add_space },
      { assertion: assert_space_notice_hidden },
      { action: action_remove_space },
      { assertion: assert_empty_space_notice },
      { assertion: assert_initial_profile_missing },
    ],
  };
});

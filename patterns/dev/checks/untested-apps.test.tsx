/**
 * Test Pattern: the app patterns that had no test of their own
 *
 * Each of these lives in a directory of its own and is a whole small
 * application: an activity log, an agent console, a router, three chat
 * patterns built on scoped or shared profiles, a voice note, two policy demos,
 * and a regression repro kept to pin down runtime behavior. None of them had a
 * test, so nothing built any of them outside a browser.
 *
 * scope-bug-computed-vnode-blank is left out. It is a harness whose enabled
 * section exists to produce a runtime error on purpose, so a passing test
 * cannot contain it.
 *
 * Every one finds its data through wishes rather than through inputs, so in an
 * empty space each has to come up with an empty view rather than fail. This
 * builds each one, checks the name it goes under, and reads its rendered tree,
 * which is what runs the derived expressions inside it.
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import ActivityLog from "../../apps/activity-log/activity-log.tsx";
import Agent from "../../apps/agent/agent.tsx";
import CfcPromptInjectionDemo from "../../examples/cfc-agent-prompt-injection-demo/main.tsx";
import CfcRowLabelRecords from "../../examples/cfc-row-label-records/main.tsx";
import VoiceNote from "../../system/notes/voice-note.tsx";
import ProfileGroupChat from "../../examples/profile-group-chat/main.tsx";
import Router from "../../examples/router/main.tsx";
import ScopeReduceRepro from "../scope-bug-ct1597-reduce/main.tsx";
import ScopedGroupChatPlainInputs from "../../examples/scoped-group-chat/main-plain-inputs.tsx";
import SharedProfileRoster from "../../examples/shared-profile-roster/main.tsx";
import { textContent } from "../../tools/test-support/vnode-helpers.ts";

export default pattern(() => {
  const activityLog = ActivityLog({});
  const agent = Agent({});
  const router = Router({});
  const profileGroupChat = ProfileGroupChat({});
  const scopedGroupChat = ScopedGroupChatPlainInputs({});
  const sharedProfileRoster = SharedProfileRoster({});
  const promptInjectionDemo = CfcPromptInjectionDemo({});
  const rowLabelRecords = CfcRowLabelRecords({});
  const scopeReduceRepro = ScopeReduceRepro({});
  const voiceNote = VoiceNote({});

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_apps_named = assert(() =>
    router[NAME] === "Main" &&
    profileGroupChat[NAME] === "Profile group chat" &&
    scopedGroupChat[NAME] === "Scoped group chat" &&
    sharedProfileRoster[NAME] === "Shared-profile roster"
  );

  const assert_cfc_demos_named = assert(() =>
    promptInjectionDemo[NAME] === "CFC agent prompt injection demo" &&
    rowLabelRecords[NAME] === "Per-Row × Per-Column Labels (CFC Phase 3)"
  );

  const assert_repro_named = assert(() =>
    scopeReduceRepro[NAME] === "Cozy lunch poll"
  );

  const assert_chat_apps_render = assert(() =>
    textContent(profileGroupChat[UI]).length > 0 &&
    textContent(scopedGroupChat[UI]).length > 0 &&
    textContent(sharedProfileRoster[UI]).length > 0
  );

  const assert_tools_render = assert(() =>
    textContent(activityLog[UI]).length > 0 &&
    textContent(agent[UI]).length > 0 &&
    textContent(router[UI]).length > 0 &&
    voiceNote[NAME] === "Voice Note" &&
    textContent(voiceNote[UI]).length > 0
  );

  const assert_cfc_demos_render = assert(() =>
    textContent(promptInjectionDemo[UI]).length > 0 &&
    textContent(rowLabelRecords[UI]).length > 0
  );

  // The repro exists because a tree came back blank, so a tree with text in
  // it is the whole of what it claims.
  const assert_repro_renders = assert(() =>
    textContent(scopeReduceRepro[UI]).length > 0
  );

  return {
    [TESTS]: [
      { assertion: assert_apps_named },
      { assertion: assert_cfc_demos_named },
      { assertion: assert_repro_named },
      { assertion: assert_chat_apps_render },
      { assertion: assert_tools_render },
      { assertion: assert_cfc_demos_render },
      { assertion: assert_repro_renders },
    ],
  };
});

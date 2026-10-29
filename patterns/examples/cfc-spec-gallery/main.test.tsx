import {
  assert,
  handler,
  NAME,
  pattern,
  Stream,
  TESTS,
  UI,
} from "commonfabric";
import {
  findNodeById,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import Gallery from "./main.tsx";

const FORWARD_RECIPIENT = "night-audit@hotel.example";
const RESEARCH_COMMAND =
  "Research the product launch and email a short briefing to launch@example.com";
const SAFE_LINK_SOURCE =
  "https://source.example.com/private/source?token=debug&draft=internal";

const trigger = handler<void, { stream: Stream<void> }>((_, { stream }) => {
  stream.send();
});

const sendString = handler<void, { stream: Stream<string>; next: string }>((
  _,
  { stream, next },
) => {
  stream.send(next);
});

export default pattern(() => {
  const instance = Gallery({});

  const action_prepare_forward = trigger({
    stream: instance.prepareForwardHotelNote,
  });
  const action_forward_note = trigger({ stream: instance.runForwardHotelNote });
  const action_capture_command = trigger({
    stream: instance.runCaptureDirectCommand,
  });
  const action_prepare_brief = trigger({
    stream: instance.runPreviewResearchBrief,
  });
  const action_authorize_send = trigger({
    stream: instance.runAuthorizeResearchSend,
  });
  const action_prepare_safe_link = trigger({
    stream: instance.prepareSafeLinkRelease,
  });
  const action_release_safe_link = trigger({
    stream: instance.runReleaseSafeLink,
  });
  const action_membership = trigger({
    stream: instance.runHotelMembershipReturn,
  });
  const action_select_search_result = trigger({
    stream: instance.runSelectSearchResult,
  });
  const action_finalize_checklist = trigger({
    stream: instance.runFinalizeChecklist,
  });
  const action_confirm_receipt = trigger({
    stream: instance.runConfirmReceipt,
  });
  const action_acknowledge_disclosure = trigger({
    stream: instance.runAcknowledgeDisclosure,
  });
  const action_acknowledge_alert = trigger({
    stream: instance.runAcknowledgeAlert,
  });
  const action_accept_invite = trigger({
    stream: instance.runAcceptInvite,
  });
  const action_release_redacted_summary = trigger({
    stream: instance.runReleaseRedactedSummary,
  });
  const action_escalate_support_case = trigger({
    stream: instance.runEscalateSupportCase,
  });

  const action_change_forward_recipient = sendString({
    stream: instance.setForwardRecipient,
    next: FORWARD_RECIPIENT,
  });
  const action_change_command = sendString({
    stream: instance.setResearchCommand,
    next: RESEARCH_COMMAND,
  });
  const action_change_source_url = sendString({
    stream: instance.setSafeLinkSource,
    next: SAFE_LINK_SOURCE,
  });

  const assert_count = assert(() => instance.totalExamples === 16);
  const assert_names_itself = assert(() =>
    instance[NAME] === "CFC Worked Example Gallery"
  );
  // Reaching into the rendered view is what builds it. Every card here is a
  // call to one of this pattern's view helpers, and nothing else in this file
  // asks for the view, so without this they run only where a browser renders
  // the gallery — which is to say on some CI runs and not others.
  const assert_renders_header = assert(() =>
    hasText(findNodeById(instance[UI], "gallery-count"), "16 total examples")
  );
  const assert_forward_prepared = assert(() => instance.completedCount === 0);
  const assert_forward_committed = assert(() =>
    instance.completedCount === 1 &&
    instance.lastCompleted === "forward-hotel-note"
  );
  const assert_research_captured = assert(() =>
    instance.completedCount === 1 &&
    instance.lastCompleted === "forward-hotel-note"
  );
  const assert_research_prepared = assert(() => instance.completedCount === 1);
  const assert_research_sent = assert(() =>
    instance.completedCount === 2 &&
    instance.lastCompleted === "authorize-research-send"
  );
  // The gallery reports the three inputs its trusted surfaces read back out,
  // alongside the raw note the forward drew its bounded excerpt from. Each is
  // a separate computed, and nothing else in this file reads any of them.
  const assert_reports_its_inputs = assert(() =>
    instance.forwardRecipientInput === FORWARD_RECIPIENT &&
    instance.researchCommandInput === RESEARCH_COMMAND &&
    instance.safeLinkSource === SAFE_LINK_SOURCE &&
    instance.forwardSourceNote.includes("Raw inbox context stays in the note.")
  );
  const assert_safe_link_prepared = assert(() =>
    instance.completedCount === 2 &&
    instance.lastCompleted === "authorize-research-send"
  );
  const assert_safe_link_released = assert(() =>
    instance.completedCount === 3 &&
    instance.lastCompleted === "release-safe-link"
  );
  const assert_four_single_step_examples_completed = assert(() =>
    instance.completedCount === 7 &&
    instance.lastCompleted === "release-safe-link"
  );
  // Driving the last five takes the gallery to all twelve of the examples
  // `completedCount` counts. Their handlers write nowhere else, so this is
  // where each of those five bodies runs.
  const assert_every_example_completed = assert(() =>
    instance.completedCount === 12 &&
    instance.acknowledgeDisclosure ===
      "User acknowledged the disclosure before release" &&
    instance.acknowledgeAlert ===
      "Critical alert acknowledged with explicit UI intent" &&
    instance.acceptInvite ===
      "Accepted the shared-space invite with trusted provenance" &&
    instance.releaseRedactedSummary ===
      "Released the redacted summary instead of the raw note" &&
    instance.escalateSupportCase ===
      "Escalated the support case with the approved excerpt"
  );

  return {
    [TESTS]: [
      { assertion: assert_count },
      { assertion: assert_names_itself },
      { assertion: assert_renders_header },
      { action: action_change_forward_recipient },
      { action: action_prepare_forward },
      { assertion: assert_forward_prepared },
      { action: action_forward_note },
      { assertion: assert_forward_committed },
      { action: action_change_command },
      { action: action_capture_command },
      { assertion: assert_research_captured },
      { action: action_prepare_brief },
      { assertion: assert_research_prepared },
      { action: action_authorize_send },
      { assertion: assert_research_sent },
      { action: action_change_source_url },
      { assertion: assert_reports_its_inputs },
      { action: action_prepare_safe_link },
      { assertion: assert_safe_link_prepared },
      { action: action_release_safe_link },
      { assertion: assert_safe_link_released },
      { action: action_membership },
      { action: action_select_search_result },
      { action: action_finalize_checklist },
      { action: action_confirm_receipt },
      { assertion: assert_four_single_step_examples_completed },
      { action: action_acknowledge_disclosure },
      { action: action_acknowledge_alert },
      { action: action_accept_invite },
      { action: action_release_redacted_summary },
      { action: action_escalate_support_case },
      { assertion: assert_every_example_completed },
    ],
    instance,
  };
});

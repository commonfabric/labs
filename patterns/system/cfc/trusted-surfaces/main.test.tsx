import {
  assert,
  handler,
  pattern,
  Stream,
  TESTS,
  Writable,
} from "commonfabric";
import {
  SAVE_DRAFT_ACTION,
  SAVE_TITLE_ACTION,
  TRUSTED_SAVE_DRAFT_SURFACE,
  TRUSTED_SAVE_SURFACE,
  TrustedAudiencePublishSurface,
  TrustedConversationSendSurface,
  TrustedDirectCommandSurface,
  TrustedDisclaimerAckSurface,
  TrustedFactCheckGateSurface,
  TrustedForwardSurface,
  TrustedLongRunningJobSurface,
  TrustedProvenanceReviewSurface,
  TrustedRecipientConfirmSurface,
  TrustedRedactedReleaseSurface,
  TrustedSafeLinkSurface,
  TrustedSaveDraftSurface,
  TrustedSaveSurface,
  TrustedSharePolicySurface,
  TrustedSongIdRecordingSurface,
} from "./mod.ts";

const setString = handler<void, { value: Writable<string>; next: string }>((
  _,
  { value, next },
) => {
  value.set(next);
});

const trigger = handler<void, { stream: Stream<void> }>((_, { stream }) => {
  stream.send();
});

export default pattern(() => {
  const draftTitle = new Writable("");
  const savedTitle = new Writable("");
  const draftBody = new Writable("");
  const savedBody = new Writable("");
  // The save-draft surface needs its OWN saved-title cell: a cell's CFC
  // uiContract must remain stable, so one cell cannot be claimed by both
  // TrustedSaveSurface and TrustedSaveDraftSurface.
  const savedDraftTitle = new Writable("");

  const forwardSource = new Writable(
    "Guest arrives late and needs the bell desk to hold room access after midnight. Raw inbox context stays in the note.",
  );
  const forwardRecipient = new Writable("ops@hotel.example");
  const forwardPrepared = new Writable("");
  const forwardedNote = new Writable("");

  const commandInput = new Writable(
    "Research Common Fabric launch updates and email a three-bullet brief to team@example.com",
  );
  const capturedCommand = new Writable("");
  const preparedBrief = new Writable("");
  const authorizedSend = new Writable("");

  const sourceUrl = new Writable(
    "https://source.example.com/private/report?token=secret-token&draft=internal",
  );
  const preparedSafeLink = new Writable("");
  const releasedSafeLink = new Writable("");

  const conversationTitle = new Writable("");
  const audienceInput = new Writable("");
  const messageDraft = new Writable("");
  const sentMessage = new Writable("");

  const targetAudience = new Writable("");
  const publishSubject = new Writable("");
  const publishBody = new Writable("");
  const preparedAudiencePublish = new Writable("");
  const publishedAudiencePost = new Writable("");

  const disclaimerText = new Writable("");
  const acknowledgedDisclaimer = new Writable("");

  const provenanceText = new Writable("");
  const reviewedProvenance = new Writable("");

  const factCheckClaim = new Writable("");
  const factCheckResult = new Writable("");

  const songHint = new Writable("");
  const identifiedSongId = new Writable("");

  const policyAudience = new Writable("");
  const policyScope = new Writable("");
  const savedSharePolicy = new Writable("");

  const jobName = new Writable("");
  const jobStatus = new Writable("");
  const jobAuthorization = new Writable("");
  const jobCancellation = new Writable("");

  const recipientLabel = new Writable("");
  const recipientPayloadPreview = new Writable("");
  const confirmedRecipientRelease = new Writable("");

  const redactionLabel = new Writable("");
  const redactionSourceText = new Writable("");
  const releasedRedactedContent = new Writable("");

  const trustedSave = TrustedSaveSurface({ draftTitle, savedTitle });
  const trustedSaveDraft = TrustedSaveDraftSurface({
    draftTitle,
    draftBody,
    savedTitle: savedDraftTitle,
    savedBody,
  });
  const trustedForward = TrustedForwardSurface({
    sourceNote: forwardSource,
    recipientInput: forwardRecipient,
    preparedPreview: forwardPrepared,
    forwardedNote,
  });
  const trustedDirect = TrustedDirectCommandSurface({
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
  });
  const trustedSafeLink = TrustedSafeLinkSurface({
    sourceUrl,
    preparedSafeLink,
    releasedSafeLink,
  });
  const trustedConversationSend = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });
  const trustedAudiencePublish = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });
  const trustedDisclaimerAck = TrustedDisclaimerAckSurface({
    disclaimerText,
    acknowledgedDisclaimer,
  });
  const trustedProvenanceReview = TrustedProvenanceReviewSurface({
    provenanceText,
    reviewedProvenance,
  });
  const trustedFactCheckGate = TrustedFactCheckGateSurface({
    factCheckClaim,
    factCheckResult,
  });
  const trustedSongIdRecording = TrustedSongIdRecordingSurface({
    songHint,
    identifiedSongId,
  });
  const trustedSharePolicy = TrustedSharePolicySurface({
    policyAudience,
    policyScope,
    savedSharePolicy,
  });
  const trustedLongRunningJob = TrustedLongRunningJobSurface({
    jobName,
    jobStatus,
    jobAuthorization,
    jobCancellation,
  });
  const trustedRecipientConfirm = TrustedRecipientConfirmSurface({
    recipientLabel,
    payloadPreview: recipientPayloadPreview,
    confirmedRecipientRelease,
  });
  const trustedRedactedRelease = TrustedRedactedReleaseSurface({
    redactionLabel,
    sourceText: redactionSourceText,
    releasedRedactedContent,
  });

  const action_set_title = setString({
    value: draftTitle,
    next: "Saved from trusted surface",
  });
  const action_set_draft_body = setString({
    value: draftBody,
    next: "Draft body",
  });
  const action_set_recipient = setString({
    value: forwardRecipient,
    next: "night-audit@hotel.example",
  });
  const action_prepare_forward = trigger({
    stream: trustedForward.prepareForward,
  });
  const action_commit_forward = trigger({ stream: trustedForward.forwardNote });
  const action_capture_command = trigger({
    stream: trustedDirect.captureCommand,
  });
  const action_prepare_brief = trigger({ stream: trustedDirect.prepareBrief });
  const action_authorize_send = trigger({
    stream: trustedDirect.authorizeSend,
  });
  const action_prepare_safe_link = trigger({
    stream: trustedSafeLink.prepareSafeLink,
  });
  const action_release_safe_link = trigger({
    stream: trustedSafeLink.releaseSafeLink,
  });
  const action_set_conversation_title = setString({
    value: conversationTitle,
    next: "Project Sync",
  });
  const action_set_conversation_audience = setString({
    value: audienceInput,
    next: "product thread",
  });
  const action_set_message_draft = setString({
    value: messageDraft,
    next: "Ship the reviewed update only.",
  });
  const action_send_conversation = trigger({
    stream: trustedConversationSend.sendMessage,
  });
  const action_set_publish_audience = setString({
    value: targetAudience,
    next: "public",
  });
  const action_set_publish_subject = setString({
    value: publishSubject,
    next: "Release note",
  });
  const action_set_publish_body = setString({
    value: publishBody,
    next: "Summarize the trusted review before publish.",
  });
  const action_prepare_audience_publish = trigger({
    stream: trustedAudiencePublish.prepareAudiencePublish,
  });
  const action_publish_audience = trigger({
    stream: trustedAudiencePublish.publishAudiencePost,
  });
  const action_set_disclaimer = setString({
    value: disclaimerText,
    next: "Disclosure before use is required.",
  });
  const action_ack_disclaimer = trigger({
    stream: trustedDisclaimerAck.acknowledgeDisclaimer,
  });
  const action_set_provenance = setString({
    value: provenanceText,
    next: "Rendered provenance from trusted source.",
  });
  const action_review_provenance = trigger({
    stream: trustedProvenanceReview.reviewProvenance,
  });
  const action_set_fact_check_claim = setString({
    value: factCheckClaim,
    next: "Claim checked against trusted facts.",
  });
  const action_release_fact_check = trigger({
    stream: trustedFactCheckGate.releaseFactCheckGate,
  });
  const action_set_song_hint = setString({
    value: songHint,
    next: "Midnight Bloom",
  });
  const action_record_song_id = trigger({
    stream: trustedSongIdRecording.recordSongId,
  });
  const action_set_policy_audience = setString({
    value: policyAudience,
    next: "team",
  });
  const action_set_policy_scope = setString({
    value: policyScope,
    next: "share-only",
  });
  const action_save_policy = trigger({
    stream: trustedSharePolicy.saveSharePolicy,
  });
  const action_set_job_name = setString({
    value: jobName,
    next: "nightly export",
  });
  const action_start_job = trigger({ stream: trustedLongRunningJob.startJob });
  const action_cancel_job = trigger({
    stream: trustedLongRunningJob.cancelJob,
  });
  const action_set_recipient_label = setString({
    value: recipientLabel,
    next: "finance@example.com",
  });
  const action_set_recipient_preview = setString({
    value: recipientPayloadPreview,
    next: "Quarterly budget packet",
  });
  const action_confirm_recipient = trigger({
    stream: trustedRecipientConfirm.confirmRecipientRelease,
  });
  const action_set_redaction_label = setString({
    value: redactionLabel,
    next: "support case",
  });
  const action_set_redaction_source = setString({
    value: redactionSourceText,
    next: "Customer secret code 123-45-6789 may be released after redaction.",
  });
  const action_release_redacted = trigger({
    stream: trustedRedactedRelease.releaseRedactedContent,
  });

  const assert_saved = assert(() =>
    savedTitle.get() === "Saved from trusted surface"
  );
  const assert_saved_draft = assert(() =>
    savedDraftTitle.get() === "Saved from trusted surface" &&
    savedBody.get() === "Draft body"
  );
  const assert_forward_prepared = assert(() =>
    forwardPrepared.get() ===
      "Prepared for night-audit@hotel.example: Guest arrives late and needs the bell desk to hold room access after midnight. Only the bounded itinerary excerpt will be forwarded."
  );
  const assert_forward_committed = assert(() =>
    forwardedNote.get() === forwardPrepared.get()
  );
  const assert_command_captured = assert(() =>
    capturedCommand.get() ===
      "Research Common Fabric launch updates and email a three-bullet brief to team@example.com"
  );
  const assert_brief_prepared = assert(() =>
    preparedBrief.get() ===
      'Prepared outbound draft: concise summary for "Research Common Fabric launch updates and email a three-bullet brief to team@example.com". The send action stays separately gated.'
  );
  const assert_send_authorized = assert(() =>
    authorizedSend.get() ===
      'Authorized outbound message for "Research Common Fabric launch updates and email a three-bullet brief to team@example.com": Prepared outbound draft: concise summary for "Research Common Fabric launch updates and email a three-bullet brief to team@example.com". The send action stays separately gated.'
  );
  const assert_safe_link_prepared = assert(() =>
    preparedSafeLink.get() ===
      "https://source.example.com/private/report?view=summary"
  );
  const assert_safe_link_released = assert(() =>
    releasedSafeLink.get() ===
      "Released safe link https://source.example.com/private/report?view=summary"
  );
  const assert_conversation_sent = assert(() =>
    sentMessage.get() ===
      "Sent in Project Sync to product thread: Ship the reviewed update only."
  );
  const assert_audience_prepared = assert(() =>
    preparedAudiencePublish.get() ===
      "Prepared publish for public: Release note — Summarize the trusted review before publish."
  );
  const assert_audience_published = assert(() =>
    publishedAudiencePost.get() === preparedAudiencePublish.get()
  );
  const assert_disclaimer_acknowledged = assert(() =>
    acknowledgedDisclaimer.get() ===
      "Acknowledged trusted disclaimer: Disclosure before use is required."
  );
  const assert_provenance_reviewed = assert(() =>
    reviewedProvenance.get() ===
      "Reviewed provenance: Rendered provenance from trusted source."
  );
  const assert_fact_check_released = assert(() =>
    factCheckResult.get() ===
      "Fact-check gate opened for: Claim checked against trusted facts."
  );
  const assert_song_id_recorded = assert(() =>
    identifiedSongId.get() === "Mock song id: midnight-bloom"
  );
  const assert_share_policy_saved = assert(() =>
    savedSharePolicy.get() === "Share policy saved for team (share-only)"
  );
  const assert_job_authorized = assert(() =>
    jobStatus.get() === "Running" &&
    jobAuthorization.get() === "Authorized long-running job: nightly export"
  );
  const assert_job_cancelled = assert(() =>
    jobStatus.get() === "Cancelled" &&
    jobCancellation.get() === "Cancelled long-running job: nightly export"
  );
  const assert_recipient_confirmed = assert(() =>
    confirmedRecipientRelease.get() ===
      "Confirmed release to finance@example.com: Quarterly budget packet"
  );
  const assert_redacted_released = assert(() =>
    releasedRedactedContent.get() ===
      "Released redacted support case: Customer [redacted-secret] code [redacted-id] may be released after redaction."
  );

  return {
    [TESTS]: [
      { action: action_set_title },
      // The `savedTitle` / `savedBody` writes carry TrustedAction UI
      // contracts: send the renderer-trusted gesture for the reviewed surface
      // directly to the surface's stream.
      {
        action: trustedSave.save,
        trustedUi: {
          surface: TRUSTED_SAVE_SURFACE,
          action: SAVE_TITLE_ACTION,
        },
      },
      { assertion: assert_saved },
      { action: action_set_draft_body },
      {
        action: trustedSaveDraft.saveDraft,
        trustedUi: {
          surface: TRUSTED_SAVE_DRAFT_SURFACE,
          action: SAVE_DRAFT_ACTION,
        },
      },
      { assertion: assert_saved_draft },
      { action: action_set_recipient },
      { action: action_prepare_forward },
      { assertion: assert_forward_prepared },
      { action: action_commit_forward },
      { assertion: assert_forward_committed },
      { action: action_capture_command },
      { assertion: assert_command_captured },
      { action: action_prepare_brief },
      { assertion: assert_brief_prepared },
      { action: action_authorize_send },
      { assertion: assert_send_authorized },
      { action: action_prepare_safe_link },
      { assertion: assert_safe_link_prepared },
      { action: action_release_safe_link },
      { assertion: assert_safe_link_released },
      { action: action_set_conversation_title },
      { action: action_set_conversation_audience },
      { action: action_set_message_draft },
      { action: action_send_conversation },
      { assertion: assert_conversation_sent },
      { action: action_set_publish_audience },
      { action: action_set_publish_subject },
      { action: action_set_publish_body },
      { action: action_prepare_audience_publish },
      { assertion: assert_audience_prepared },
      { action: action_publish_audience },
      { assertion: assert_audience_published },
      { action: action_set_disclaimer },
      { action: action_ack_disclaimer },
      { assertion: assert_disclaimer_acknowledged },
      { action: action_set_provenance },
      { action: action_review_provenance },
      { assertion: assert_provenance_reviewed },
      { action: action_set_fact_check_claim },
      { action: action_release_fact_check },
      { assertion: assert_fact_check_released },
      { action: action_set_song_hint },
      { action: action_record_song_id },
      { assertion: assert_song_id_recorded },
      { action: action_set_policy_audience },
      { action: action_set_policy_scope },
      { action: action_save_policy },
      { assertion: assert_share_policy_saved },
      { action: action_set_job_name },
      { action: action_start_job },
      { assertion: assert_job_authorized },
      { action: action_cancel_job },
      { assertion: assert_job_cancelled },
      { action: action_set_recipient_label },
      { action: action_set_recipient_preview },
      { action: action_confirm_recipient },
      { assertion: assert_recipient_confirmed },
      { action: action_set_redaction_label },
      { action: action_set_redaction_source },
      { action: action_release_redacted },
      { assertion: assert_redacted_released },
    ],
    trustedSave,
    trustedSaveDraft,
    trustedForward,
    trustedDirect,
    trustedSafeLink,
    trustedConversationSend,
    trustedAudiencePublish,
    trustedDisclaimerAck,
    trustedProvenanceReview,
    trustedFactCheckGate,
    trustedSongIdRecording,
    trustedSharePolicy,
    trustedLongRunningJob,
    trustedRecipientConfirm,
    trustedRedactedRelease,
  };
});

# Shared CFC Primitive Index

This index lists the primitives that pattern authors are expected to reuse from
`patterns/system/cfc/`.

## Admin Registry

From `admin/mod.ts`:

- `AdminSubject`
- `AdminRoleAssignment`
- `ActiveAdminRole`
- `AdminRegistryStoredValue`
- `EmptyAdminRegistryValue`
- `AdminRegistryValue`
- `adminRegistryEntries`
- `adminRegistryEveryoneIsAdmin`
- `activeAdminRoleForSubject`
- `subjectHasAdminRole`

Use these when a pattern has its own admin role vocabulary but wants the shared
registry shape and common lookup helpers.

## Trusted Action Contracts

From `commonfabric`:

- `TrustedActionWriteWithIntegrity`
- `TrustedActionWrite`
- `TrustedActionUiContract`

Use these when defining CFC output types for writes that must be authorized by a
trusted UI action.

## Shared Atom Vocabulary

From `commonfabric/cfc`:

- `CFC_ATOM_TYPE`
- `CFC_CONCEPT_KIND`
- `CFC_FUSE_ATOM_CLASS`
- `CFC_RUNTIME_SUBJECT`
- `cfcAtom`
- `CfcAtom`
- `CfcPromptSlotBoundAtom`
- `CfcPromptSlotInfluenceAtom`

Use these from shared CFC helpers when constructing common atom evidence.
Pattern authors should still keep local resource subjects, digests, routes, and
domain policy vocabulary beside the pattern that owns them.

## Trusted Surfaces

Import trusted surfaces through `trusted-surfaces/mod.ts`.

Save and publish workflow:

- `TrustedSaveSurface`
- `TrustedSaveDraftSurface`
- `TrustedReviewSurface`
- `TrustedPublishSurface`
- `TrustedSaveTitleUiContract`
- `TrustedSavedDraftTitleUiContract`
- `TrustedSavedDraftBodyUiContract`
- `TrustedReviewedTitleUiContract`
- `TrustedReviewedBodyUiContract`
- `TrustedPublishedTitleUiContract`
- `TrustedPublishedBodyUiContract`
- `commitTrustedSaveTitle`
- `saveTrustedDraftSnapshot`
- `reviewTrustedSnapshot`
- `publishTrustedSnapshot`

Forwarding, command capture, and links:

- `TrustedForwardSurface`
- `TrustedDirectCommandSurface`
- `TrustedSafeLinkSurface`
- `prepareTrustedForward`
- `commitTrustedForward`
- `captureTrustedDirectCommand`
- `prepareTrustedResearchBrief`
- `commitTrustedResearchSend`
- `prepareTrustedSafeLink`
- `commitTrustedSafeLink`

Conversation and publishing:

- `TrustedConversationSendSurface`
- `TrustedAudiencePublishSurface`
- `commitTrustedConversationSend`
- `prepareTrustedAudiencePublish`
- `commitTrustedAudiencePublish`

Disclosure, provenance, and review gates:

- `TrustedDisclaimerAckSurface`
- `TrustedProvenanceReviewSurface`
- `TrustedFactCheckGateSurface`
- `acknowledgeTrustedDisclaimer`
- `reviewTrustedProvenance`
- `commitTrustedFactCheckGate`

Process and release gates:

- `TrustedSongIdRecordingSurface`
- `TrustedSharePolicySurface`
- `TrustedLongRunningJobSurface`
- `TrustedRecipientConfirmSurface`
- `TrustedRedactedReleaseSurface`
- `recordTrustedSongId`
- `saveTrustedSharePolicy`
- `authorizeTrustedLongRunningJob`
- `cancelTrustedLongRunningJob`
- `confirmTrustedRecipientRelease`
- `releaseTrustedRedactedContent`

Common surface identity constants are exported next to their surfaces, for
example `TRUSTED_SAVE_SURFACE`, `TRUSTED_FORWARD_SURFACE`, and
`TRUSTED_REDACTED_RELEASE_SURFACE`.

## Prompt-Injection Helpers

Import prompt-injection helpers through `prompt-injection/mod.ts`.

Atoms:

- `DEFAULT_PROMPT_INJECTION_RISK_KIND`
- `DEFAULT_PROMPT_INFLUENCE_KIND`
- `INJECTION_SAFE_ATOM`
- `promptInjectionRiskAtom`
- `promptInfluenceAtom`
- `trustedAgentKernelAtom`
- `userSurfaceInputAtom`
- `promptSlotBoundAtom`

Prompt and message helpers:

- `PromptAttachment`
- `PromptSendEvent`
- `promptInputMessage`
- `makeUserPromptMessage`

Schemas:

- `EMPTY_TOOL_INPUT_SCHEMA`
- `TEXT_OR_LINK_SCHEMA`
- `sendMailInputSchema`
- `confidentialMessagesSchema`

Tools and sub-agent:

- `TextOrLink`
- `ResultSchemaInput`
- `SendMailArgs`
- `SendMailResult`
- `ReadResourceResult`
- `PromptInjectionTool`
- `readResourceTool`
- `sendMailTool`
- `parseResultSchemaInput`
- `subAgentPattern`

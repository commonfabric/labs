# CFC Helper Authoring Guide

Use this guide when creating or promoting shared CFC helpers under
`packages/patterns/cfc/`.

This guide documents the authoring patterns used by the current shared helpers
so pattern authors can add new helpers without first learning every part of the
CFC runtime.

## Mental Model

CFC helpers are normal pattern code plus policy metadata. The metadata is
carried by TypeScript type aliases from `commonfabric`.

The main pieces helper authors use are:

- `AddIntegrity<T, I>`: the value has additional integrity evidence `I`.
- `RequiresIntegrity<T, I>`: the value may be used only when integrity evidence
  `I` is present.
- `WriteAuthorizedBy<T, typeof handler>`: a writable output may be modified by
  that handler identity.
- `PolicyOf<typeof rules>`: a value is governed by one static exported
  module-policy manifest.
- `AnyOf<[A, B]>`: explicitly places alternatives in one disjunctive
  confidentiality clause; without it, entries are conjunctive.
- `Cfc<T, Metadata>`: attaches explicit CFC metadata that does not have a
  narrower helper alias yet.

For trusted UI actions, two checks matter:

- write authority: the target output type names the handler that is allowed to
  write it
- event integrity: the handler may only be triggered by an event from a trusted
  rendered surface with the required event-integrity labels

The shared `TrustedActionWrite` aliases combine these. The trusted surface
renders matching `data-ui-pattern`, `data-ui-event-integrity`, and
`data-ui-action` attributes so the trusted renderer can bind the click to the
reviewed UI that produced it.

For prompt-injection helpers, treat atoms and schemas as evidence builders, not
as policy decisions. A helper can build atoms like `PromptSlotBound` or
`UserSurfaceInput`, but the caller must supply the user, surface, source, role,
digest, and route-specific integrity requirements.

## Binding Private Stores To Their Creator

A `Confidential` declaration with a direct `User` clause whose subject is
`CurrentPrincipal` restricts a fresh store to the authenticated principal whose
transaction creates it. Commit preparation resolves that subject to a concrete
DID and persists it in the store's schema and label. A transaction without an
authenticated principal cannot create that declaration.
`CurrentPrincipal` inside alternatives or other confidentiality atom shapes is
not supported.

Later writes with the same symbolic declaration retain the concrete stored user
clauses. A different writer does not become the store's reader by writing to it,
and an explicit replacement of those clauses remains subject to the ordinary
monotonic schema-merge checks. This binding concerns confidentiality; it does
not grant write authority or mint a principal attestation.

A placeholder already present in a stored schema or confidentiality label is
not an authenticated creator identity. Commit preparation and schema-update
preflight refuse that unresolved stored policy. Writing the store or passing a
held reference does not bind it to the current writer; it requires an explicitly
authorized migration instead of automatic creator binding.

Private declarations behind local or external schema references merge at their
value paths. Reusing one definition at two fields does not combine their stored
creators. Unchanged IFC policy and reference structure retain recursive
references through public value-shape changes, including optional fields inside
private objects. Changed recursive policy graphs that require expansion are
refused; unrelated recursive schemas remain supported.
Held references derive their labels from the source's creator binding during
commit, including when the source is created in that transaction. A later writer
holding the reference does not replace the source's bound principal.

Scopes and confidentiality serve different purposes. `PerUser` selects a user's
state instance; a confidentiality declaration restricts who can read that
instance under a bounded runtime read ceiling. Space ACLs do not enforce these
per-cell labels on raw server reads. `PerSpace` selects one shared instance. For a creator-private shared
inbox, initialize that instance under its intended owner's authenticated
transaction before accepting visitor writes. Binding uses the principal creating
the store, not a profile displayed by the pattern or the first person intended
to read it.

To publish a reviewed copy of private data, use the native
[`cf-share-snapshot`](../components/COMPONENTS.md#cf-share-snapshot) surface. An
ordinary handler or authored trusted-action label does not itself grant
confidentiality release authority. Snapshot sharing retains the source labels
and creates a separate copy for the confirmed audience.

## Authoring Direct Exchange Rules

Import rule declarations from `commonfabric/cfc`. Keep every rule and its
owning rule set as exported, module-level static declarations:

```ts
import type { Confidential } from "commonfabric";
import {
  cfcPattern,
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";

export const releaseToReader = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [
      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),
    ],
  },
  post: { addAlternatives: [cfcPattern.user(v("reader"))] },
});

export const rules = exchangeRules([releaseToReader]);
export type ProtectedText = Confidential<
  string,
  readonly [PolicyOf<typeof rules>]
>;
```

`cfcPattern` builds match patterns and accepts `v(...)` /
`THIS_POLICY.subject`; `cfcAtom` builds concrete runtime atoms. Do not mix the
two. To release what one function of the policy's own module computed, match
the runtime-minted `TransformedBy` atom and name the module with
`THIS_POLICY.moduleIdentity` rather than a pasted hash; see
`packages/patterns/cfc-exchange-rules/blessed-computation.tsx`. The runtime
mints that atom only when every write of a transaction comes from one verified
function, and the pattern's `symbol` must be that function's export name — the
function exported under that one name — or the rule never fires. The compiler
rejects dynamic content, unbound variables, unguarded rules, non-exported
declarations, and reused rules. At label creation the runtime
binds the owning space and durably installs the exact digest-addressed manifest
in the destination; an unresolved or mismatched artifact fails closed.

See `packages/patterns/cfc-exchange-rules/` for the copyable example and native
test.

## Start With The Boundary

Before writing a helper, identify the CFC boundary it supports:

- trusted UI action: a user click authorizes a protected write
- role or registry lookup: local role vocabulary needs reusable storage and
  lookup shape
- prompt/tool boundary: direct user authority must stay separate from untrusted
  document influence
- disclosure or release gate: a value can move only after a reviewed surface
  records the required action

If you cannot name the boundary, keep the code local. Shared CFC helpers should
make policy structure reusable; they should not hide the policy decision.

## Authoring Trusted Action Types

Use the trusted action aliases from `commonfabric` when a helper writes to a
protected output from a specific handler.

```ts
import { handler, type TrustedActionWrite, Writable } from "commonfabric";

export const TRUSTED_REVIEW_SURFACE = "TrustedReviewSurface";
const REVIEW_TITLE_ACTION = "TrustedReviewTitle";

export const reviewTitle = handler<
  void,
  {
    draftTitle: Writable<string>;
    reviewedTitle: Writable<string>;
  }
>((_, { draftTitle, reviewedTitle }) => {
  reviewedTitle.set(draftTitle.get().trim());
});

export type ReviewedTitleWrite = TrustedActionWrite<
  string,
  typeof reviewTitle,
  typeof REVIEW_TITLE_ACTION,
  typeof TRUSTED_REVIEW_SURFACE
>;
```

Use `TrustedActionWriteWithIntegrity` when one surface requires more evidence
than the surface identity alone. Existing examples use this for gates that need
both the trusted surface and an extra review/disclosure/action label.

Use `TrustedActionUiContract<T, Action, Pattern>` when the value itself should
carry the UI contract metadata, usually for fields that are passed around as
reviewed values after the write.

Keep action and surface constants local to the helper file. Export the surface
identity constant; do not export local demo vocabulary as shared policy.

## Authoring Trusted Surfaces

Put one reusable surface per file under
`packages/patterns/cfc/trusted-surfaces/`, and export it from
`trusted-surfaces/mod.ts`.

A trusted surface should contain four pieces:

1. Generic input cells for the local values it edits or displays.
2. Handler functions that perform the protected write.
3. Output types that label protected outputs with `TrustedActionWrite`.
4. UI with matching trusted-event dataset attributes.

```tsx
import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export const TRUSTED_APPROVAL_SURFACE = "TrustedApprovalSurface";
const APPROVE_ACTION = "TrustedApprove";

export const approveReviewedValue = handler<
  void,
  {
    draft: Writable<string>;
    approved: Writable<string>;
  }
>((_, { draft, approved }) => {
  approved.set(draft.get().trim());
});

export interface TrustedApprovalSurfaceInput {
  draft: Writable<string>;
  approved: Writable<string>;
}

export interface TrustedApprovalSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  approved: TrustedActionWrite<
    string,
    typeof approveReviewedValue,
    typeof APPROVE_ACTION,
    typeof TRUSTED_APPROVAL_SURFACE
  >;
  approve: Stream<void>;
}

export const TrustedApprovalSurface = pattern<
  TrustedApprovalSurfaceInput,
  TrustedApprovalSurfaceOutput
>(({ draft, approved }) => {
  const approve = approveReviewedValue({ draft, approved });

  return {
    [NAME]: computed(() => "Trusted Approval Surface"),
    [UI]: (
      <cf-card
        id="trusted-approval-surface"
        data-ui-pattern={TRUSTED_APPROVAL_SURFACE}
        data-ui-event-integrity={TRUSTED_APPROVAL_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted approval</cf-heading>
          <cf-button data-ui-action={APPROVE_ACTION} onClick={approve}>
            Approve
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    approved,
    approve,
  };
});
```

The dataset attributes and type metadata must agree:

- `data-ui-pattern` should equal the exported trusted surface constant.
- `data-ui-event-integrity` should include the event-integrity labels required
  by the output contract.
- `data-ui-action` should equal the action string in the `TrustedActionWrite`
  type.

Use generic names and neutral copy. A trusted surface may say what operation it
performs, such as "publish" or "confirm recipient", but it should not mention a
demo fixture, route name, customer, model, mailbox, or app-specific role.

## Authoring Admin Helpers

Admin helpers are for the reusable registry shape, not for a global admin
policy. The local pattern owns the role names, subjects, and integrity labels.

Use this shape when a pattern has:

- a list of role assignments stored in one registry value
- one reviewed handler that every change to that list goes through
- subject equality that should work for cells or structured objects

One integrity atom runs through all of it. The roles carry it, the list carries
it, and the list's floor asks for it. There is no second atom naming "who may
edit the roster": a floored write may only consume reads that share a single
witness atom for the floor, and deciding a roster change means reading the
roster, so a floor on one atom over roles carrying another can never be met.

The registry value around the list is written out here rather than reused from
`AdminRegistryValue`. The floor, the mint and the write binding sit on the list
type, which is where the schema records them, and `AdminRegistryValue<Role>`
fixes that field as `readonly Role[]`: the element type is yours to choose, and
the array around it is not, so there is no `Role` that puts a contract on the
list. The other two fields go the same way. `everyoneIsAdmin` is there, as a
plain `boolean`, which is the one form that cannot name the handler allowed to
flip it, so a pattern holding that flag to one write binding declares it again.
A bootstrap role, the first grant made while the roster is still open, has no
field at all. Every pattern that floors a registry declares its own value for
those reasons.

```ts
// Shown at module scope.
import {
  type AddIntegrity,
  type Default,
  handler,
  type RequiresIntegrity,
  type Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  adminRegistryEntries,
  type AdminRoleAssignment,
  type EmptyAdminRegistryValue,
  subjectHasAdminRole,
} from "../cfc/admin/mod.ts";

const PROJECT_ADMIN = "project-admin" as const;

type ProjectSubject = { projectId: string };

type ProjectAdminRole = AddIntegrity<
  AdminRoleAssignment<ProjectSubject>,
  readonly [typeof PROJECT_ADMIN]
>;

// `AddIntegrity` on the list mints the atom the floor beside it asks for. The
// atom each role carries labels the entries, and does not reach the list path
// the floor is declared on, so a list of endorsed roles with no mint of its
// own refuses every write to itself.
type ProjectAdminList = RequiresIntegrity<
  WriteAuthorizedBy<
    AddIntegrity<ProjectAdminRole[], readonly [typeof PROJECT_ADMIN]>,
    typeof commitProjectAdminChange
  >,
  readonly [typeof PROJECT_ADMIN]
>;

interface ProjectAdminRegistryStoredValue {
  readonly admins?: ProjectAdminList;
}
type ProjectAdminRegistry =
  | ProjectAdminRegistryStoredValue
  | Default<EmptyAdminRegistryValue>;

// The switch that reveals the admin controls is a plain boolean any viewer may
// set for themselves, so it carries no integrity. Give it one and every
// protected write that reads it inherits an endorsement its own user granted.
type ProjectAdminManagerModeCell = Writable<boolean>;

declare const registry: Writable<ProjectAdminRegistry>;
declare const subject: ProjectSubject;

const admins: ProjectAdminRole[] = adminRegistryEntries(registry);
const isAdmin = subjectHasAdminRole(admins, subject);

// The handler named in the list's `writeAuthorizedBy` contract is the only
// code that may write the roster, so an unreviewed action elsewhere in the
// pattern cannot reach it. The binding says which code may write. It does not
// say which person may, and the mode switch does not either, so the handler
// checks the acting subject's own role: an empty roster is open, so the first
// admin can exist, and after that only an admin grants one.
const commitProjectAdminChange = handler<
  { subject: ProjectSubject; displayName: string },
  {
    registry: Writable<ProjectAdminRegistry>;
    managerMode: ProjectAdminManagerModeCell;
    actor: ProjectSubject;
  }
>((event, { registry, managerMode, actor }) => {
  if (managerMode.get() !== true) return;
  const current: ProjectAdminRole[] = adminRegistryEntries(registry);
  if (current.length > 0 && !subjectHasAdminRole(current, actor)) return;
  if (subjectHasAdminRole(current, event.subject)) return;
  registry.key("admins").set([
    ...current,
    { subject: event.subject, displayName: event.displayName },
  ] as ProjectAdminList);
});
```

Promote only registry-neutral behavior. Keep local actions like "make parking
captain", "grant room moderator", or "assign project owner" beside the owning
pattern, because those actions define domain policy.

The five rules that make a floored registry work, and the failure each one
produces when it is broken, are in `packages/patterns/cfc/README.md` under
"Floor An Admin Registry". The parking coordinator, the lobby, the lot watch
and the group-chat demo have each had to be repaired for breaking one of them,
so read that section before writing a new registry.

## Authoring Prompt-Injection Helpers

Prompt-injection helpers support a specific CFC distinction: direct user command
authority is not the same as untrusted document influence. Command-like text in
a document remains a labeled source value until trusted runtime evidence binds
it to an accepted prompt slot and route.

Shared helpers should cover repeatable mechanics:

- atom builders for known evidence shapes
- schema builders that encode required integrity
- text-or-link schemas for opaque observations
- prompt event conversion
- tool wrappers that preserve handler types
- sub-agent wrappers that fail closed on malformed result schemas

Do not put hostile fixtures, routes, model choices, mailbox addresses, or demo
resource ids in shared prompt helpers.

### Atom Builders

Atoms are evidence values. Builders should require callers to supply the
policy-sensitive parameters.

```ts
// Shown at module scope.
import {
  promptInfluenceAtom,
  promptInjectionRiskAtom,
  promptSlotBoundAtom,
  trustedAgentKernelAtom,
  userSurfaceInputAtom,
} from "../cfc/prompt-injection/mod.ts";

const kernel = trustedAgentKernelAtom("agent-kernel-v1");
const sourceRisk = promptInjectionRiskAtom(sourceRef);
const sourceInfluence = promptInfluenceAtom(sourceRef);
const userInput = userSurfaceInputAtom(userDid, surfaceName, valueDigest);
const slot = promptSlotBoundAtom(
  promptSource,
  "direct-command",
  "agent-kernel-v1",
  userDid,
  surfaceName,
  valueDigest,
);
```

When adding a new atom helper, mirror the atom registry name and parameters.
Prefer required parameters over optional defaults unless the default is an
official concept URI or a stable shared profile value.

Common atom type URLs and generic builders live in the public
`commonfabric/cfc` module. Shared helpers under `packages/patterns/cfc/` should
import that module instead of spelling atom `type` URLs by hand.

### Schema Builders

Schema helpers should make authority requirements visible at the field that
needs them.

```ts
// Shown at module scope.
import {
  confidentialMessagesSchema,
  sendMailInputSchema,
} from "../cfc/prompt-injection/mod.ts";

const sendSchema = sendMailInputSchema([kernel, userInput, slot]);
const messageSchema = confidentialMessagesSchema([
  sourceRisk,
  sourceInfluence,
]);
```

Use `TEXT_OR_LINK_SCHEMA` when a tool may receive an opaque link instead of raw
text. This lets a workflow pass a protected value through without forcing the
agent to observe the underlying confidential content.

### Sub-Agent Wrappers

The shared `subAgentPattern` parses result schemas and fails closed for invalid
schema inputs. Preserve that rule in new wrappers: an invalid schema should not
be treated like permissive schema `true`.

Keep wrappers generic. The local pattern should supply:

- prompt and messages
- result schema
- tools
- model and token settings
- observation ceiling
- route-specific system prompt

## Promotion Checklist

Create a shared helper only when the code is policy-generic and has clear reuse
value. Good candidates include:

- CFC contract type aliases that encode a recurring trusted UI pattern
- reusable trusted surfaces with domain-neutral inputs and copy
- generic admin registry or credential helpers
- prompt-injection utilities that are not tied to one hostile fixture

Keep code local when it contains:

- app-specific label atoms or integrity strings
- resource subjects, value digests, routes, sinks, or endpoint names
- demo data, hostile or benign fixtures, model choices, or UI copy
- domain-specific role transitions or workflow decisions

Before moving code into `packages/patterns/cfc/`:

1. Name the boundary the helper supports.
2. Verify the helper does not choose local policy for callers.
3. Migrate at least one existing caller.
4. Add the helper to `packages/patterns/cfc/INDEX.md`.
5. Add a usage note to `packages/patterns/cfc/README.md` if it creates a new
   helper category.

## Verification

Use the narrowest meaningful checks:

```sh
deno task cf test packages/patterns/<pattern>/main.test.tsx --root packages/patterns
deno task cf check packages/patterns/<pattern>/main.tsx --no-run
deno fmt --check <touched files>
```

For trusted surfaces, include coverage that exercises the exported stream or
handler path and verifies the protected output changes only through the trusted
surface path.

For admin helpers, cover:

- empty registry defaults, and the bootstrap grant an empty roster allows
- a viewer holding no role refused, and an admin granting one accepted
- the per-user mode switch changing what is on screen and nothing else
- a roster write from outside the handler named in the write binding refused
- subject lookup for the local subject shape
- a second roster change after the first, which is the one a floor naming two
  atoms drops

For prompt-injection helpers, cover:

- generated schemas include the expected required integrity
- text-or-link values are accepted where opaque observations are expected
- malformed result schemas fail closed
- local fixtures remain local after extraction

Broaden to `deno task check` when the helper affects multiple CFC demos or
shared contract types.

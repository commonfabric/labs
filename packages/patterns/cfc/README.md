# Shared CFC Pattern Helpers

This directory is the shared authoring library for reusable CFC pattern code.
Start here before copying CFC policy helpers out of an existing demo.

For a categorized list of reusable primitives, see [INDEX.md](./INDEX.md).

## Use A Trusted Surface

Trusted surfaces wrap an explicit UI action with the CFC event-integrity
contract expected by the runtime. Use one when the user action should be
authorized only from a reviewed surface instead of from arbitrary host UI.

```tsx
import { pattern, UI, Writable } from "commonfabric";
import {
  TrustedSaveSurface,
  type TrustedSaveTitleUiContract,
} from "../cfc/trusted-surfaces/mod.ts";

export default pattern(() => {
  const draftTitle = new Writable("");
  const savedTitle = new Writable<TrustedSaveTitleUiContract>("");
  const trustedSave = TrustedSaveSurface({ draftTitle, savedTitle });

  return {
    [UI]: (
      <cf-vstack>
        {trustedSave}
        <div>{savedTitle}</div>
      </cf-vstack>
    ),
    savedTitle,
    save: trustedSave.save,
  };
});
```

The host pattern owns where the surface appears and how the protected value is
displayed. The shared surface owns the reviewed action, disclosure copy, button,
and CFC write contract.

## Use Admin Helpers

Use `admin/mod.ts` when a pattern has a local notion of "admin" but wants the
common registry shape and helper functions. The pattern still defines its own
subject and integrity labels.

```ts
import {
  adminRegistryEntries,
  adminRegistryEveryoneIsAdmin,
} from "../cfc/admin/mod.ts";
import {
  type AddIntegrity,
  type RequiresIntegrity,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const PROJECT_ADMIN_INTEGRITY = "project-admin" as const;

interface ProjectAdminRoleAssignment {
  subject: { projectId: string };
  displayName: string;
}

type ProjectAdminRole = AddIntegrity<
  ProjectAdminRoleAssignment,
  readonly [typeof PROJECT_ADMIN_INTEGRITY]
>;

type ProjectAdminList = RequiresIntegrity<
  WriteAuthorizedBy<
    AddIntegrity<
      ProjectAdminRole[],
      readonly [typeof PROJECT_ADMIN_INTEGRITY]
    >,
    typeof commitProjectAdminChange
  >,
  readonly [typeof PROJECT_ADMIN_INTEGRITY]
>;

const admins = adminRegistryEntries<ProjectAdminRole>(adminRegistry);
const everyoneIsAdmin = adminRegistryEveryoneIsAdmin(adminRegistry);
```

One atom runs through the whole registry, and the list is both endorsed and
floored with it. The next section says why each of those is there, and why a
second atom for "who may edit the roster" does not work.

Keep subject lookup and local role toggling in the pattern when the domain model
is local, such as people, profiles, rooms, or projects.
`adminRegistryEveryoneIsAdmin` treats an empty admin list as bootstrap mode:
everyone is an admin until the pattern writes at least one explicit admin role
or explicitly stores `everyoneIsAdmin: false`. That bootstrap is what answers
"who may take the first seat" — an empty roster is open, and once a role exists
the roster gates itself.

There is no helper here for "this actor may edit the roster", and a registry
does not need one. The per-user switch that reveals the admin controls is a
plain boolean carrying no integrity, and the roster's own `writeAuthorizedBy`
binding is what decides which code may change it. A separate `*-admin-manager`
atom standing for the authority to edit is the shape the parking coordinator,
the lobby and the lot watch were each repaired out of; the next section says why
it cannot work.

## Floor An Admin Registry

A `requiredIntegrity` floor is a requirement on the value being written, and the
runtime also screens the reads that fed that write. Five rules follow, and each
fails in its own way. Break one of the first two and the floor is unsatisfiable:
the runtime refuses every write to the path the floor was meant to guard. Break
the third and a write that lands a fresh value still goes through, while one
that moves a value already stored there is refused. Break the fourth and the
writes go through, endorsed by something the user granted themselves — the
protection is there and it admits the wrong writer. Break the fifth and the
registry ends up holding authority that nobody can exercise and nobody can
repair.

**Mint on the path the floor sits on.** The floor asks what the value at that
exact path carries. `AddIntegrity` on an array's items endorses the items; it
says nothing about the array, so a floor on the array path still rejects. Wrap
the list in `AddIntegrity` of the atom its floor names.

**One atom per authority.** A floored write may only consume reads that share a
single witness atom for the floor. Checking whether the acting person may write
one protected path usually means reading another — the role registry — so both
paths have to name the same atom. Two atoms in one flow, such as an `admin` atom
and a separate `admin-manager` atom, make every such write unsatisfiable: the
registry read carries one, the floor demands the other, and nothing carries
both.

**Endorse the entries too.** A value written into an endorsed location is stored
as its own document, and moving that entry later writes a link the runtime has
to label from the entry's own stored label. An entry with no label of its own
cannot be re-linked, so rewriting a list around a removal fails. Endorse both:
the entries, so each keeps a label of its own, and the list, so it satisfies its
floor.

**A self-granted flag is not a credential.** A per-user cell any viewer can set
for themselves must carry no integrity. Give it one and every protected write
that consults it inherits an endorsement its own user granted. Authority belongs
in the role registry, and the registry belongs to one reviewed handler named in
the list's `writeAuthorizedBy` contract, so that a write from anywhere else — an
unreviewed action in the same pattern, or another pattern holding the same cell
— is refused by the runtime rather than by convention.

**A role names someone who is there.** Once a roster gates itself, a role
granted to a subject no actor can be fills the roster without giving anyone the
authority to change it, and the bootstrap that opened the first grant never
reopens. Grant only to a subject drawn from the pattern's own list of them.

Which subject you pick decides how much of that you have to enforce by hand.
Name a person by name and you own three rules: a rename has to move the role, a
removal has to drop it, and a later person of that name must not inherit it.
Name the profile **cell** instead, comparing subjects with
`activeAdminRoleForSubject` and `subjectHasAdminRole`, and the first and third
stop existing — a rename moves nothing, and a newcomer arrives holding no
profile at all. Two traps come with cells, both of them load-bearing. An unset
optional cell input reads back as a present-but-empty handle, so it is truthy
and a presence test on it always passes: gate on a name string, which is
honestly `""` when nothing resolved. And pin the terminal cell with
`resolveAsCell()` before storing one, or what gets stored is "whoever the reader
resolves".

Two of these describe this runtime rather than the CFC specification, and an
author who goes looking for them in the specification will not find them. The
specification checks a write target's `requiredIntegrity` against the written
value alone (`commonfabric/specs` `cfc/08-12-store-label-monotonicity.md`
§8.12.4.1), and scopes the shared-witness rule to the reads at or below the
annotated path (`cfc/08-10-validation-at-boundaries.md` §8.10.3). This runtime
screens a floored write against every labeled read that preceded it in the
transaction, which is stronger, and which is what leaves two atoms in one flow
with no way to satisfy each other. Entries become documents of their own because
of how this runtime stores a value written into a labeled location; the remedy
of labeling each entry is what the specification's link-carried label component
expects either way (`cfc/08-12-store-label-monotonicity.md` §8.12.8).

One more shape is worth knowing before designing around it. The specification
composes write authority as a **set** of handler identities, one per handler
declaring that it writes the path (`cfc/08-15-write-authority.md` §8.15.2). The
authoring surface here names a single binding, so every operation on a protected
path has to reach that path through one handler. Operations that would otherwise
carry their own authorization end up as events into it, and their authorization
has to be decided by the caller, before the state the handler would need to
check it against has moved.

`packages/patterns/factory-outputs/parking-coordinator/main.tsx` follows all
five. `packages/patterns/lobby/main.tsx` binds its registry to a reviewed
handler the same way, with profiles rather than names as role subjects.
`packages/patterns/factory-outputs/lot-watch/main.tsx` binds a registry whose
subjects are names, and `packages/patterns/cfc-group-chat-demo/trusted.tsx`
floors a second list, its rooms, on the same atom as its roster.

## Use Prompt-Injection Helpers

Use `prompt-injection/` when building a CFC demo or workflow that separates
direct user authority from untrusted document influence. The helpers build the
common atoms, schemas, prompt messages, and generic tools while the pattern owns
its specific resource, prompt, fixtures, and routes.

```ts
import {
  confidentialMessagesSchema,
  INJECTION_SAFE_ATOM,
  promptInfluenceAtom,
  promptInjectionRiskAtom,
  promptInputMessage,
  promptSlotBoundAtom,
  sendMailInputSchema,
  subAgentPattern,
  trustedAgentKernelAtom,
  userSurfaceInputAtom,
} from "../cfc/prompt-injection/mod.ts";

const risk = promptInjectionRiskAtom(untrustedResource);
const influence = promptInfluenceAtom(untrustedResource);
const kernel = trustedAgentKernelAtom("agent-kernel-v1");
const userInput = userSurfaceInputAtom(userDid, surfaceName, valueDigest);
const slot = promptSlotBoundAtom(
  promptSource,
  "direct-command",
  "agent-kernel-v1",
  userDid,
  surfaceName,
  valueDigest,
);

const sendSchema = sendMailInputSchema([kernel, userInput, slot]);
const briefingSchema = confidentialMessagesSchema([risk, influence]);
const trustedPromptMessage = promptInputMessage(event);
const requiredIntegrity = [kernel, userInput, slot, INJECTION_SAFE_ATOM];
```

The prompt helpers use the shared CFC atom vocabulary from `commonfabric/cfc`.
Use these builders instead of spelling atom `type` URLs by hand in shared
helpers.

Call shared builders from inside the pattern body unless the value is plain
static data. CFC-authored pattern code cannot use arbitrary top-level call
results in SES mode.

## What Stays Local

Keep app-specific policy vocabulary beside the owning pattern:

- concrete label atoms, integrity strings, resource subjects, and value digests
- demo fixtures, hostile or benign sample data, routes, copy, and model choices
- domain-specific role subjects, such as a parking person name or chat profile
- workflow code whose behavior is only meaningful inside one demo

Shared helpers should provide reusable policy structure, not centralize every
policy decision.

## Adding A Shared Helper

Promote code into this directory only when it has a generic name, no local demo
fixture data, and at least one migrated caller. Add focused pattern tests or
`cf check --no-run` coverage for the moved code, then document the helper in
[INDEX.md](./INDEX.md).

For the full authoring checklist, read
`docs/common/ai/cfc-helper-authoring-guide.md`.

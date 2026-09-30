# Space Name Registry Implementation Plan

## Status

Concept design. No implementation or deployment is currently planned. The
one-shot implementation details remain here so the design can be evaluated
independently if it is reconsidered.

[Common Fabric URLs](../specs/fabric-urls.md) is the source of truth for URL
syntax, DNS namespace resolution, registry targets, redirects, and displayed
URLs. This plan describes one implementation of that specification.

The concept is independent of the active
[random space identities](random-space-identities.md) plan. It accepts every
valid space DID, including existing deterministically derived DIDs.
Implementing it would not change how a space DID is created. Conversely,
random space identities use existing DID routes without this registry.

## Principles

- A space DID is the space's durable identity. A registered name is a mutable
  route to a DID.
- A URL has one meaning for everyone for whom it resolves. Authentication can
  decide whether a user may read the result, but it cannot change the target.
  The empty-space URL is the specified exception because it explicitly means
  the current user's home space.
- The displayed URL can differ by viewer. Each displayed URL still has the same
  viewer-independent meaning when another user opens it.
- The browser hostname identifies the ASP. ASP routing is not encoded in a
  query parameter.
- Every toolshed process in an ASP reads and writes one logical authoritative
  registry. Process-local memory is never authoritative.
- Registration ownership and space ownership are separate facts. Owning a name
  permits changing that entry. Owning a space gives that owner's names priority
  when the browser chooses a displayed URL.
- Names never derive private keys, DIDs, ACLs, or storage locations.
- The registry implements the target forms in the URL specification directly.
  It does not introduce a second alias language.
- A move redirect is ASP-local routing metadata keyed by a space DID. It
  preserves the continuation of requests that reach that ASP after an explicit
  move. It is separate from registered names and does not participate in name
  ownership or displayed-URL selection.
- Abuse prevention, registration quotas, and namespace-control proof protocols
  remain provider policy. Ordinary request and storage limits still protect
  the service under load.

## Connected specifications

- [Common Fabric URLs](../specs/fabric-urls.md) is the normative contract. This
  plan does not narrow its namespace, redirect, registration, or presentation
  behavior.
- [CFC space principals](https://github.com/commonfabric/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/03-core-concepts.md#361-space-principals)
  and
  [CFC causal addressing](https://github.com/commonfabric/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/17-addressing-and-storage.md#171-causal-id-storage-core-cfc-path)
  separate stable identifiers from access authority. Registry resolution ends
  in a DID and does not supply `HasRole` or a storage capability.
- [CFC `HasRole` fact generation](https://github.com/commonfabric/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/04-label-representation.md#493-hasrole-fact-generation)
  makes the ACL the membership record. The displayed-URL algorithm reads that
  ownership fact rather than treating registration ownership as space
  ownership.
- [Pattern import resolution](../specs/pattern-imports/README.md#open-questions)
  keeps stable `cf:` source references DID-based. Browser names resolve through
  Common Fabric URLs before a retained source reference is stored.
- [Piece source routing](../specs/piece-source-lifecycle.md#common-fabric-browser-link-receipt)
  consumes the ASP and DID produced by Common Fabric URL resolution. The move
  redirect proposed here preserves old browser URLs. Replacing an open storage
  session remains part of the separate space-transfer and runtime-routing work.
- [Shell routes](../../packages/shell/README.md#routes) and the
  [navigation guide](../common/patterns/navigation.md) consume the shared URL
  parser. Higher-priority application and embed routes stay outside the
  catch-all resolver.
- The [Home space list](../common/conventions/HOME_SPACE.md#spaces) is personal
  display metadata. It does not become an implicit registry or change what a
  public URL resolves to.
- The [FUSE path specification](../specs/fuse-filesystem/2-path-scheme.md#space-name-resolution)
  uses explicit name-to-DID mappings. It can remember a resolved Common Fabric
  URL, but directory lookup does not claim or derive a registry name.
- [Toolshed request authentication](../specs/toolshed-access-control.md#request-proof-format)
  supplies the existing identity-proof vocabulary for registry mutations.
- [Toolshed storage configuration](../development/CONFIGURATION.md#memory-store)
  describes Common Memory storage rather than a deployment-wide metadata
  database. The registry therefore needs the separate PostgreSQL authority in
  this plan.
- Earlier `ct-space` work proposed an
  [address book](https://github.com/commonfabric/labs/blob/a81a9009f7adb46eddd96b411e564deba8eaf7d0/docs/acl.md)
  and
  [provider-directed petname resolution](https://github.com/commonfabric/labs/blob/f5c70f5fca70d80a6a58902ea318f3b65fe97d06/docs/space-petnames.md).
  Common Fabric URLs now settles the browser-facing contract those documents
  left open.

## Preparation

- Inventory every browser route, API route, static asset, embed route, and
  framework fallback that has priority over the Common Fabric catch-all route.
- Inventory existing named URLs and record their exact current DID and ASP.
  Produce migration rows before changing route resolution. If the inventory is
  empty, add no compatibility rows or compatibility code.
- Confirm the production toolshed topology, including replicas, load balancers,
  PostgreSQL writers and readers, failover fencing, and DNS resolvers. Record
  which component owns the public ASP hostname.
- Verify the current ACL operation that answers whether an identity owns a
  space. Define one shared ownership predicate everywhere displayed-URL
  selection evaluates space ownership.
- Decide the provider policy that supplies a verified namespace-control grant.
  The registry only consumes that grant. This plan does not invent the DNS
  challenge protocol.
- Complete the DNS standards work for the proposed `FABRIC` resource record.
  Obtain its record type number and specify its wire format, presentation
  format, hostname value grammar, and DNSSEC handling. Until that work is
  registered, no `FABRIC` record is present and a namespace identifies the
  same HTTPS hostname verbatim.
- Measure expected name counts, lookup traffic, registration traffic, and DNS
  namespace traffic. Use those figures to set pool sizes, request limits, and
  indexes before the production migration.

## Changes to make

- Add one authoritative PostgreSQL registry per ASP hostname.
  - Route every toolshed process for that hostname to the same logical primary
    for every authoritative forward lookup, presentation lookup, mutation, and
    read-after-write response. Do not serve registry answers from an
    asynchronously replicated reader.
  - Fence a former primary before a replacement accepts writes. A load balancer
    must not expose two independently writable registries for one hostname.
    Close every pooled connection to the former primary before the promoted
    primary serves reads or writes.
  - Let stateless toolshed processes be added or removed without moving
    registry state.
  - Use bounded database connection pools and bounded request bodies. Apply
    backpressure when the pool is full.
  - Set one deployment-wide connection budget and divide it across toolshed
    replicas. Adding processes must not multiply connections beyond the
    database's admitted load.
  - Do not cache registry answers in a toolshed process. Indexed PostgreSQL
    reads are the initial high-load design and preserve one answer across all
    frontends. A later shared cache must preserve the same consistency contract
    before it can replace those reads.

- Store registered names with a schema that represents the four specified
  name-target forms and the distinct space-move redirect form.
  - Use a create-only namespace table whose decoded name is the unique key
    within the ASP. Its kind is `entry` or `reserved`.
  - Store an entry row only for an `entry` namespace row. Claim both rows in one
    transaction.
  - Store the registering owner's DID, target kind, target fields, active
    state, immutable creation sequence, mutable update sequence, expected
    terminal space DID, resolution proof, and revision.
  - Represent targets as one of: namespace plus space name, short name plus
    remote ASP origin, space DID plus remote ASP origin, or space DID on this
    ASP.
  - Bind every target kind to its expected terminal DID. A redirect is valid
    only while its current chain reaches that DID. Changing the expected DID is
    an owner-authorized entry mutation and receives a new update sequence.
  - Store origins in one normalized HTTPS form. Permit HTTP only for the
    existing loopback development policy.
  - Allocate update sequences from the database. Creating or materially
    changing an entry receives a new sequence in the same transaction. An
    idempotent repeated request returns the existing revision without changing
    its order.
  - Add a unique constraint on the name. Add indexes for direct lookup and for
    active entries of every target kind by expected terminal DID, owner, and
    update sequence.
  - Keep inactive entries reserved to their owner. Deactivation stops
    resolution without making a desirable name immediately available to a
    different account.
  - Seed `reserved` rows for every higher-priority route before claims are
    accepted. A future fixed route must reserve its name through the same unique
    namespace transaction and cannot capture an existing entry.
  - Store space-move redirects in a separate registry table keyed uniquely by
    space DID. Store the normalized destination ASP origin, stable transfer
    operation identifier, active state, committed move revision, creation
    sequence, and update sequence.
  - Exclude space-move redirects from the registered-name namespace, reverse
    name indexes, registration ownership, user-requested deactivation, and
    displayed-name ordering. The transfer mechanism can retire a stale redirect
    when that ASP becomes the destination of a later move for the same DID.
  - Store active transfer operations durably. Key them by space DID and source
    ASP. Record the stable operation identifier, destination ASP, and expected
    current move-redirect revision, including the expectation that no row
    exists. Permit only one active operation for a DID on that source ASP.

- Define one parser and formatter for Common Fabric paths.
  - Percent-decode each component exactly once before validation.
  - Recognize the optional `@namespace`, optional space, and optional piece DID
    from [Common Fabric URLs](../specs/fabric-urls.md).
  - Accept namespaces only in the lowercase ASCII DNS-hostname form specified
    there. Enforce its total and per-label byte limits. Reject a trailing dot,
    empty label, uppercase input, and a label whose first or last character is
    `-`.
  - Accept short names only in the specified lowercase ASCII form. Enforce its
    byte limit and reject uppercase input or a first or last `-`.
  - Compare decoded namespaces and short names bytewise. Emit their allowed
    characters literally so one registry key has one formatted spelling.
  - Reject malformed encodings and ambiguous separators.
  - Treat higher-priority hosted resources as routes before invoking this
    parser.
  - Accept the existing piece-slug form as a user-facing compatibility input.
    After the piece loads, replace it with the piece-DID form. New code emits
    only piece DIDs.

- Implement namespace resolution consistently across toolshed processes.
  - Look up only the namespace's `FABRIC` record. If exactly one valid record is
    present, use its value as the secondary server's HTTPS hostname. If no
    record is present, use the namespace verbatim as that hostname. Reject a
    present response that does not contain exactly one valid hostname.
  - Put accepted `FABRIC` answers or the accepted absence of a record, together
    with their expiry, in a shared PostgreSQL-backed namespace cache. Do not let
    each toolshed process independently choose an authoritative answer.
  - Publish a refreshed answer atomically. Requests either observe the prior
    published answer or the replacement, never a partially refreshed value.
  - Coordinate refresh ownership in PostgreSQL so high traffic produces one
    DNS refresh rather than one refresh per process.
  - When no unexpired published answer exists, fail the namespace lookup until
    a complete answer is published. Do not guess from a stale or partial
    process-local result.
  - Redirect to HTTPS on the secondary server when it differs from the initial
    server. Preserve namespace, space, and piece components.

- Implement secondary-server space resolution in the specified order.
  - For a syntactically valid space DID, look up a space-move redirect on the
    secondary server. Use the recorded ASP as the next move-chain lookup
    location when one exists. Otherwise, open the DID only when the ASP's local
    serving state affirmatively permits local service. A missing move redirect
    alone does not permit local service.
  - Resolve an empty space component to the authenticated user's home space.
    Require authentication when the server cannot otherwise identify that
    user. Apply the same space-DID lookup to the resulting home-space DID.
  - Look up every other value by its actual registry name. Combine a namespace
    and short name as `@namespace/space`.
  - For a namespace-and-space target, resolve its namespace and redirect while
    preserving the piece.
  - For a remote short-name target, redirect to that ASP without a namespace
    and preserve the piece.
  - For a remote DID target, redirect to that ASP without a namespace and
    preserve the piece.
  - For a same-ASP DID target, apply the same space-DID lookup. Open it locally
    only when no move redirect exists and local serving state affirmatively
    permits service.
  - Resolve every redirect entry through its current chain before returning the
    redirect. Require that chain to reach the entry's expected terminal DID and
    update its resolution proof through the primary. A redirect whose current
    target cannot be proven fails rather than silently changing spaces.
    Include space-move redirects in this traversal. They preserve the terminal
    DID and contribute their move revisions to the proof.
  - Return not found for a missing or inactive name. Do not derive a DID from
    the text.
  - Follow space-move redirects through server-to-server registry lookups and
    return one HTTP redirect to the terminal ASP. Report a repeated pair of ASP
    and space DID as a redirect cycle.

- Connect the registry to the separate space-transfer mechanism.
  - Read the transfer mechanism's versioned local serving-state record when
    deciding whether this ASP may serve a DID. Creation establishes the first
    revision. Each move activation or deactivation produces a new revision.
    Do not duplicate this decision in registry state.
  - Accept a move request from an authorized owner on the source ASP. Require
    that ASP's local serving state to permit the requested space DID. The request
    names the destination ASP and the space DID.
  - Reject a move whose destination is the source ASP.
  - Reserve the move before transferring data. Use the space DID and expected
    current move-redirect revision to admit one destination. A concurrent
    request for a different destination fails instead of joining or replacing
    that move.
  - Have the source and destination ASPs establish an authenticated connection
    and transfer all data for the space through the transfer mechanism.
  - Let that mechanism define how it stops or copies concurrent writes and
    verifies the transferred data. Those operations are outside the name
    registry. Keep the source serving this route during preparation.
  - Make the destination ready with the complete space without enabling service
    for the transferred route.
  - If the destination has a stale move redirect for the DID from an earlier
    stay, keep it active while preparing the transferred data. Record its
    expected move revision in the transfer operation.
  - Perform one protected handoff on the source ASP. Make the committed move
    redirect visible and prevent new service from the source copy as one
    logical state change. A request arriving at the source after that point
    follows the registry redirect instead of opening old data.
  - After the destination verifies durable evidence of the source's committed
    move revision, retire any stale local redirect and enable local service for
    the transferred route as one protected local state change. A revision
    mismatch prevents activation.
  - Return temporary unavailability after the source publishes its redirect and
    before the destination enables service. Do not open the destination copy in
    that interval.
  - Fail without opening the destination copy during any interval in which the
    new source redirect and stale destination redirect form a cycle. The move
    completion request resolves that interval from the durable transfer record.
  - Keep the redirect after the move. A later move may produce a chain through
    earlier ASPs, and the ordinary redirect-cycle check applies to that chain.
  - Make completion idempotent for one transfer operation. Repeating a
    completion request returns the committed move revision only when its stable
    operation identifier and destination match. A conflicting completion
    fails.
  - Resume an interrupted operation from its durable reservation and committed
    move revision. Do not create a replacement operation after an uncertain
    handoff result.

- Add authenticated registry mutations.
  - Claim an unclaimed short name with a database insert protected by the
    unique constraint. Concurrent claims have exactly one winner.
  - Require a verified namespace-control grant before claiming an
    `@namespace/space` name.
  - Require the current registration owner's authorization and expected
    revision to retarget, transfer, or deactivate an entry.
  - Validate the complete proposed row before opening its transaction.
  - Commit the row mutation and new update sequence atomically.
  - Return the committed row for read-after-write behavior on any frontend.
  - Sign mutation requests with the user's existing authenticated identity.
    Do not require or retain the space's bootstrap private key.
  - Do not expose space-move redirects through the registered-name mutation
    API. Only the transfer mechanism writes or retires one as part of an
    authorized move.

- Implement displayed-URL selection after a piece loads.
  - Use the registry of the terminal ASP that serves the loaded DID. Use that
    ASP as the initial host of the displayed URL. Do not search registries from
    earlier ASPs in a move or name-redirect chain.
  - Read the space ACL with the same ownership predicate used elsewhere.
  - Query at most one newest owner-owned row and one newest current-user-owned
    row by the loaded expected terminal DID. Use the owner and update-sequence
    index, and include direct entries and all three redirect target kinds.
  - Prefer entries whose registration owner owns the space. Choose the greatest
    update sequence.
  - Otherwise prefer entries owned by the current user. Choose the greatest
    update sequence.
  - Otherwise use an empty space component for the current user's home space.
  - Otherwise use the space DID.
  - Re-resolve the selected entry after the ACL read. Verify its row revision,
    ordering, terminal DID, redirect chain, and any namespace's shared DNS-cache
    revision in one final primary-backed check.
  - Use the DID when the final check cannot prove that reopening the selected
    URL reaches the loaded DID. Never display a stale name that can resolve to a
    different space.
  - Include the namespace only when it belongs to the selected name. Include
    the current piece DID unless the root is shown.
  - Replace browser history after loading. Do not navigate or reload merely to
    change the displayed spelling.

- Supply the shell's storage route with the terminal resolution result.
  - Return the resolved space DID, normalized storage origin, and terminal
    serving-state revision in an authenticated HTTPS response from the terminal
    ASP.
  - Bind the storage origin to the resolved DID and serving-state revision.
    Accept it only from the terminal ASP reached by the verified redirect chain.
  - Reject storage origins supplied by query parameters, registered-name rows,
    or any nonterminal ASP in the redirect chain.
  - Let an ASP use its public origin as the storage origin when it proxies
    memory traffic there. Keep a distinct storage origin out of the browser
    URL.
  - Normalize and durably record the accepted route through the existing
    failure-propagating route-registration design before opening the space.

- Preserve existing user-facing URLs in the same change.
  - Insert an entry for every inventoried legacy named URL before enabling the
    new resolver. Point it at the exact DID and ASP that the URL resolved to
    before the change.
  - Turn any inventoried cross-ASP legacy URL into one of the specified redirect
    target forms.
  - Keep existing high-priority embed and application routes ahead of the
    catch-all resolver.
  - Migrate pattern and CLI code to the shared parser and formatter. Pattern
    APIs do not receive a compatibility layer for constructing obsolete URL
    forms.
  - Remove deterministic name-to-DID fallback after the migration rows exist.
  - Keep legacy `?host=` and `?spaceHost=` user-facing links as compatibility
    inputs. Validate their ASP origin, redirect to the equivalent hostname-based
    Common Fabric URL, and never emit the query form from new code.

- Deploy the database and application change as one coordinated release.
  - Apply additive tables and indexes before routing traffic to the new code.
  - Keep registry mutations denied while the catch-all resolver and legacy-URL
    redirect are installed on every frontend and every deterministic
    name-resolution session is drained.
  - Seed fixed-route reservations, then load migration rows and verify their
    exact targets while mutations remain denied.
  - Use one deployment barrier so all production frontend versions agree on
    the resolver contract. Enable the catch-all route everywhere before
    accepting the first live claim or retarget.
  - Permit snapshot rollback only before live mutations are enabled. After any
    claim, transfer, or retarget is acknowledged, preserve the authoritative
    registry and recover by rolling application code forward.
  - Do not run old and new writers against the same mutable registry.

- Verify correctness and capacity.
  - Test every URL example and every target kind in the URL specification.
  - Test percent encoding, invalid names, DIDs, empty home-space paths,
    namespaces, pieces, and higher-priority routes.
  - Test that two users opening the same nonempty URL reach the same DID.
  - Test viewer-specific displayed-name selection without viewer-specific
    resolution.
  - Race claims, retargets, transfers, and deactivations through different
    toolshed processes. Assert one committed order and immediate visibility.
  - Route repeated requests for one name across every production frontend and
    assert identical results before and after mutations.
  - Exercise database failover and prove the old writer is fenced before the
    new writer accepts mutations.
  - Prove former-primary and lagging-reader connections cannot serve either
    forward or presentation lookups after failover.
  - Prove fixed routes and registered names share one create-only namespace and
    cannot capture each other's names.
  - Change a namespace's `FABRIC` target and prove the old ASP never presents a
    URL that reopens to a different DID. Remove the record and prove the
    namespace itself becomes the secondary server after the cached answer
    expires.
  - Retarget every redirect kind and prove presentation either selects a
    currently verified entry for the loaded DID or falls back to the DID.
  - Move a space between two ASPs and prove its old DID URL, registered names on
    the source ASP, and piece URLs redirect to the same DID on the destination.
  - Prove the destination response binds that DID to its current storage origin
    and serving-state revision. Reject a storage origin from the source
    response, a URL parameter, or a response for a different DID or revision.
  - Prove the source does not publish a move redirect before the destination is
    ready, and does not serve its old copy after publishing the redirect.
  - Send reads and writes throughout the handoff. Prove each request reaches the
    source before the committed move revision, reaches the destination after
    activation, or receives temporary unavailability between those points.
    Prove neither endpoint participating in the move starts an independent
    history for the transferred route.
  - Move the space again and prove requests through each earlier ASP reach the
    latest ASP. Move it back to a former ASP and prove the stale redirect there
    is retired before service begins. Introduce a redirect cycle and prove
    resolution fails.
  - Request the DID directly from a returning destination before preparation,
    while its stale redirect awaits retirement, after the source handoff, and
    after destination activation. Prove it never opens the destination copy
    before local service for the transferred route is enabled.
  - Request the DID directly from a first-time destination after data arrives
    but before activation. Prove the missing move redirect does not make the
    prepared copy available.
  - Race moves for one DID to different destinations through different
    toolshed processes. Prove one reservation reaches the handoff and the other
    fails.
  - Exercise same-ASP DID, remote DID, remote short-name, namespace-and-space,
    empty home-space, and piece URLs through two moves. Prove each reaches the
    unchanged DID on the terminal ASP.
  - Load-test hot-name reads, cold-name reads, claims, reverse lookups, DNS
    refreshes, and connection-pool saturation at the expected production
    scale.
  - Prove an unhealthy database or namespace resolver produces a clear failure
    rather than a process-local answer.
  - Run repository formatting, lint, documentation-link, unit, integration, and
    browser checks before landing.

## Result

`https://toolshed.example/space` resolves the registered name `space` on that
ASP. A space-move redirect keeps an old DID URL and every old name that reaches
that DID working after an ASP-to-ASP transfer. Namespaced and moved spaces
follow the redirects defined by Common Fabric URLs. After a piece loads, an
owner-owned registered name is preferred, then a viewer-owned name, then the
home-space empty path, and finally the space DID. Every toolshed process
produces the same forward-resolution answer because the registry and namespace
cache have one shared authoritative state.

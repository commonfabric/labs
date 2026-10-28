# Surprising implications of CFC

A pattern looks like a React component, and most of what a React developer
knows carries over. What does not carry over is how data is protected.
Contextual Flow Control (CFC) is information flow control: every value carries
a label saying where it came from and who may see it, anything computed from a
value takes on its label, and trusted boundaries refuse any flow the label does
not permit. Several consequences of that design run against habits learned from
React and from access-control systems, and pattern authors and agents miss them
in the same ways again and again. This page lists them, the most often missed
first.

It describes CFC as designed. Most of it is built and working; where the
runtime still falls short of the design,
[`../../specs/cfc-conformance-statement.md`](../../specs/cfc-conformance-statement.md)
says so. The CFC specification is the authority on every point, and section
numbers (§) refer to it;
[`../../development/cfc-spec-correspondence.md`](../../development/cfc-spec-correspondence.md#where-the-specification-lives)
says where it lives.

1. **Reading is not the leak; flowing is.** A pattern that reaches a value it
   "should not" see, through `wish()` or a link it was handed, has not caused a
   breach: the label comes with the value, everything the pattern derives from
   it carries that label, and every place the pattern could leak it — the
   screen, a store with a weaker label, the network — refuses. The guarantee
   rests on labels being correct, not on reads being prevented, so the failure
   that matters is data written with a label weaker than its content. A design
   that hides data from a pattern instead of labeling it is solving the wrong
   problem (§3.1.4, §8.12.4). It is also why code nobody vetted can run on your
   data without a permission prompt: the question is not whether you trust the
   code but whether anything can leave.

2. **A violation is a refusal, not a warning.** CFC is not an audit log that
   records what a pattern did wrong: a write that would weaken a label is
   refused, and a value the viewer may not see is not rendered. Design for the
   refusal, a write that does not happen or a placeholder where the value would
   be, rather than expecting a console message and a working feature (§8.10.6,
   §18.6.3).

3. **Trust is layered, and the pattern is the least trusted layer.** The runtime
   is trusted most, then the renderer, then the `cf-*` components, then
   patterns. A component is not trusted with everything; it is trusted to do
   only what it is for, which is more than a pattern is trusted with. So a
   component can read and draw a cell that the pattern embedding it holds only
   as a reference, as `<cf-input $value={cell}>` does, and the pattern is not
   tainted by what the component shows. UI that must show data its host may not
   see belongs in a component, not in a pattern (§9.2.1).

4. **A pattern has no general-purpose DOM or browser API.** There are no refs,
   no layout reads, and no measuring after render: pattern code runs in a worker
   and produces view nodes, and the renderer turns them into DOM somewhere the
   pattern cannot reach. Nor is there `fetch`, `localStorage`, or the rest of
   the browser; every effect goes through a runtime builtin, so the runtime sees
   every flow. What comes back from the screen is only what the renderer and
   components choose to send, as event fields and as writes to cells bound with
   `$prop`. So "the pattern could measure the layout" is the wrong worry, and "a
   component forwards a content-dependent measurement, such as the height of
   what it rendered" is the right one, because every field a component emits is
   a release to the pattern (`packages/html/src/main/events.ts`,
   [`SES_SANDBOXING_SPEC.md`](../../specs/sandboxing/SES_SANDBOXING_SPEC.md)).

5. **Time is coarse, and the runtime hands it to you.** A pattern has no timers,
   no `performance.now()`, and no `requestAnimationFrame`; in a handler
   `Date.now()` is the time of the triggering event, rounded to the second, and
   in a `computed()` or `lift()` it throws. A fine clock is a side channel, and
   a derivation that reads the clock or a random number is not idempotent, so
   the reactive graph would not settle. A pattern that needs the current time
   asks for a clock that ticks, `wish({ query: "#now/60" })` for one that ticks
   each minute, and precise timing, as a game needs, is out of scope ([timing
   side channels](../../specs/sandboxing/TIMING_SIDE_CHANNELS.md)).

6. **An iframe gets the whole browser and gives up trusted UI.** A `cf-iframe`
   guest is a real document: it can use the DOM, measure layout, run timers, and
   bring React or D3. The price is that the renderer cannot vouch for anything
   the guest draws, so a guest cannot host trusted `cf-*` components, and its
   events are never a trusted gesture. And because a guest can reach the
   network, handing it data is checked as a flow that can leave the device, not
   only as display, so a guest may be refused data that the same page could show
   in a component ([`iframe-pattern-guide.md`](../ai/iframe-pattern-guide.md)).

7. **Loading a URL is a send.** An `<img src>`, a CSS `url()`, a link the
   browser prefetches, or anything else that makes the browser fetch a resource
   tells the server at that address something, and the address itself can carry
   data out. So the renderer treats setting such a property as network egress,
   decided by a stricter rule than display: a value that may appear on screen
   may still be refused as an image address (§8.10.6; `REMOTE_LOAD_PROPS` in
   `packages/html/src/worker/reconciler.ts`).

8. **Rendering is a flow, and the viewer is its audience.** Showing a value on
   screen is checked like sending it anywhere else: a value the viewer may not
   see renders as a redacted placeholder, and a pattern cannot declassify for
   display on its own say-so. "It's only shown, not sent" is no exemption, and
   the same piece can show a value to one user and withhold it from another
   (§8.10.6). Embedding a piece never shows more than opening it directly would,
   and an enclosing boundary can show less ([render-boundary
   composition](../../specs/cfc-render-boundary-composition.md)).

9. **Composition already gathers; it needs no registry.** A parent that
   instantiates sub-patterns holds their results and reads their outputs
   directly, and reading a child's labeled output taints the parent exactly as
   any other read does. Designs keep inventing a collector, a registry, or a
   broadcast channel for what composition already hands the parent with the
   labels right. Passing a child's output along as a reference, without reading
   it, does not take on its content label, though the reference's own label
   still flows (§8.2.4, §8.13.4; [composition](../patterns/composition.md)).

10. **Taint is per computation, not per variable.** A computation is tainted by
    everything it reads, not just by the values that reach a given output, so
    one unrelated secret read in a handler taints every write it makes. Keeping
    work that reads sensitive data in its own `computed()`, apart from work that
    does not, is what keeps the second one clean (§8.9.2). The same goes for
    lists: one `computed()` over a whole list gives everything it derives the
    label of the whole list, while `.map()` runs a separate computation per
    item, so each row keeps its own label, plus whatever the per-item function
    captures from outside the row (§8.5.4.3).

11. **A label is a list of conditions, and a reader must satisfy all of them.**
    Each clause of a confidentiality label says who may read, and a reader must
    satisfy every clause, so listing several people as separate clauses means
    "only someone who is all of them". "Any of these people" is one clause with
    alternatives (`AnyOf`), and it governs only itself: clauses that arrived
    with the inputs still apply (§3.1.4, §3.1.8). You see your own data because
    you are one of its readers, not because of an owner exception, and pattern
    code has no owner bypass (§5.3.2).

12. **Whether something happened is as secret as what made it happen.** A read
    that only decides a branch, or whether to write at all, still taints the
    result, and a computation that re-runs because a cell changed carries the
    label of what triggered it. A notification, a wake-up, or a badge count is
    as confidential as the data that caused it; "just a ping, no content" leaks
    that the content exists (§8.9.2, §8.11.3, invariant 9).

13. **An `onClick` is not consent.** In React any click handler is "the user did
    it". Here a click counts as the user's intent only when it is bound to what
    a trusted surface actually rendered, so the user is known to have seen the
    thing they approved. A pattern cannot manufacture consent with its own
    button; sharing, sealing, and other sensitive actions go through components
    built for them (§3.8.1, §6.3).

14. **Where data came from is minted, never claimed.** Integrity such as
    "arrived over this channel" or "written by this sender" is added only by
    trusted code, the runtime or a vetted importer, and the data cannot assert
    it about itself. A `from` field is a claim, and authorship is only as strong
    as the authentication of the channel it came through: a sender who is
    verified by one channel is merely named by another (§3.3, §5.6).

15. **Endorsement adds evidence; it never removes a restriction.** Integrity is
    a set of claims a value has, starting empty, and endorsing adds a claim; it
    does nothing to confidentiality, which only a release rule removes
    (§3.1.6.2, §3.7.2). Combining values keeps only the claims they share, and
    most claims belong to the exact value, so any transformation drops them; a
    trusted value mixed with an untrusted one is untrusted (§8.6.2).

16. **Changing the code changes who may write.** Write authority belongs to the
    code, identified by its content, not to the author or the piece, so an edit
    to a pattern's source makes its handlers new writers, and rebinding the code
    is re-authorization, not inheritance (§8.15.6). A field that names its
    writer refuses an updated pattern until the update is authorized as the old
    version's successor.

17. **Model output influenced by someone else's text stays influenced.** When a
    prompt includes text a third party wrote, such as a message from a contact
    mentioning a party, the output carries a prompt-influence marking, and
    screening the input or the output for injection does not clear it. Only
    evidence tied to the same source and destination, such as a disclosure the
    user saw, discharges it, and letting the output choose a destination or
    recipient needs stronger evidence still (§8.10.5, §10.1).

18. **Release is the data owner's decision, one clause at a time.** Code does
    not declassify by deciding to: a release needs a rule carrying the authority
    of the principal whose restriction it removes, and removing one principal's
    restriction leaves everyone else's in place (§5.3.3, invariants 3, 11 and
    15). A design where a pattern "decides the user meant to share it" is
    missing the rule that would let it. A rule richer than labels can express,
    such as "share my location in the fifteen minutes before a meeting", is
    trusted code that produces evidence ("a meeting starts within fifteen
    minutes") plus a declarative rule the owner accepted that releases when the
    evidence is present; the code does not decide the release itself (§12.2.1).
    And because combining data keeps every clause, mixing your own private data
    into a result meant for someone else adds your clause to it, which that
    result's release rule has no authority to remove (§3.1.2).

19. **Untrusted input must not choose what is released, to whom, or when.**
    Every parameter that sets a release's scope, destination, audience, or
    trigger must carry the integrity the policy requires, so a recipient address
    or a send time taken from an incoming message cannot steer a release even
    when the release itself is permitted. A reader list computed from stored
    content counts as an audience (§3.8.4, invariant 7). Absence is an input
    too: checking whether a field exists is a read, and a missing or empty
    record grants nothing, so an empty list of administrators must never mean
    everyone (§4.3.5, §4.6.3).

20. **Nothing may endorse on a branch that depends on a secret.** Whether an
    endorsement happened would reveal the secret it compared against, so an
    endorsement decision that needs data the endorser cannot see fails closed
    (§3.8.5, invariant 8).

21. **Counting or filtering rows you cannot read leaks them.** A count, a total,
    or an empty result over rows outside the reader's clearance reveals that
    they exist, so anything derived from them is tainted by them, and silently
    skipping unreadable rows is a release that a policy has to permit (§8.17.1,
    §8.17.2, invariant 14).

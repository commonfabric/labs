# Cross-Origin Isolation Posture

## Status

Decision Record

## Last Updated

2026-06-16

This note records a deliberate, regression-guarded security decision. The
deployed Common Fabric application is served so that it is not cross-origin
isolated. It complements the
[SES Sandboxing Specification](SES_SANDBOXING_SPEC.md), which covers the
primary enforcement mechanism for untrusted pattern code.

## The decision

The served shell document is never given the header combination that makes a
browser turn on cross-origin isolation. Concretely, we do not serve both
`Cross-Origin-Opener-Policy: same-origin` and a require-corp or credentialless
`Cross-Origin-Embedder-Policy` together. As a result, `self.crossOriginIsolated`
stays `false` in the served document.

## Why

This product runs untrusted user programs ("patterns") inside the same web page
as the rest of the application. Those patterns are sandboxed with Secure
ECMAScript (SES). A core defense against Spectre-class timing attacks is that a
pattern cannot build a high-resolution timer. In a browser, the primitives that
make such a timer easy to build are only handed to a page once it is
cross-origin isolated. By staying non-isolated, the browser never makes those
primitives available at the page level at all, which gives a defense-in-depth
layer sitting underneath the SES taming. The rest of this document is the threat
analysis that justifies that choice and explains why the obvious-sounding
counter-arguments do not hold for our threat model.

## Threat analysis

### Actors

There are three kinds of code to keep distinct:

- Trusted application code. The shell and runtime that we ship. It runs at our
  own origin.
- Untrusted patterns. User-authored programs that run inside our own page, at
  our own origin, sandboxed only by SES. There is no process or origin boundary
  between a pattern and the trusted application code, so they share one renderer
  process and one address space.
- Untrusted embedded origins (future). Third-party content we expect to embed in
  cross-origin iframes. These run at a different origin from us. For third-party
  content, which is also a different site, the browser places them in a
  different renderer process by default (see "Embedding untrusted cross-origin
  iframes" below).

The asset we are protecting is the confidentiality of memory inside our renderer
process: secrets, capabilities, and the data of other patterns that happen to
share the address space with an attacking pattern.

### The asset an attacker needs is a clock

A Spectre-class attack reads memory inside the attacker's own process that the
attacker should not be able to observe, by measuring tiny timing differences
left behind by speculative execution. The attack has two ingredients. The first
is a way to provoke speculative execution, which any JavaScript engine provides.
The second is a high-resolution timer to measure the result. Removing the timer
is therefore the defense that is actually in our hands.

A `SharedArrayBuffer` is more than one more timer; it works as a timer factory.
Even if `performance.now()` is clamped or removed, a `SharedArrayBuffer` shared
with a second thread lets the attacker build its own clock. One thread
increments a counter in the shared buffer in a tight loop, and the other thread
reads that counter as a monotonically rising clock with very fine resolution.
This is why browsers disabled `SharedArrayBuffer` outright after Spectre was
published, and why they only restored it behind cross-origin isolation. Denying
the shared buffer is what makes the clamped clock meaningful.

### What cross-origin isolation actually does

Turning on cross-origin isolation (serving
`Cross-Origin-Opener-Policy: same-origin` together with a require-corp or
credentialless `Cross-Origin-Embedder-Policy`) does two separate things, and
they point in opposite directions for us:

1. It unlocks the dangerous primitives. `SharedArrayBuffer`, `Atomics`, shared
   `WebAssembly.Memory`, and an un-clamped `performance.now()` become available
   to the page. These are the timer and timer-factory primitives we want to deny
   to untrusted patterns.
2. It places strict conditions on the page's process, and only then exposes
   those primitives. A require-corp or credentialless
   `Cross-Origin-Embedder-Policy` forces every cross-origin subresource and
   frame to opt in, through `Cross-Origin-Resource-Policy`, CORS, or being
   loaded without credentials, so that no un-opted-in cross-origin data shares
   the page's process. A `Cross-Origin-Opener-Policy` of `same-origin` keeps the
   page out of a shared browsing context group with cross-origin documents.
   These conditions are the precondition the browser insists on before it will
   hand out the primitives in point 1. Once they hold, the only memory a Spectre
   read could reach is memory the page is already allowed to access, so exposing
   `SharedArrayBuffer` leaks nothing new.

The condition in point 2 reads like a separate security benefit, but it is only
the price of admission for point 1, and point 1 is what we are trying to avoid.
There is no standalone "a process of our own" prize on offer here. Modern
browsers already run documents from different sites in different renderer
processes by default, through Site Isolation, whether or not we are cross-origin
isolated. So the process boundary that protects us from a different-site
attacker is something we already have. What cross-origin isolation would add is
to tighten that keying to the full origin and to certify the process as free of
un-opted-in cross-origin data, and it does this only as the gate that unlocks
the dangerous primitives.

That gate defends against the wrong threat for us. Our untrusted code is
same-origin, since it is the page. No amount of origin-level or site-level
process keying separates an attacking pattern from the trusted code it sits
beside, because they are the same origin in the same process either way.
Meanwhile the cost in point 1 lands squarely on the threat we do have. So for
this product the trade is backwards. We would re-arm the timer for in-page
untrusted code in exchange for a process guarantee that does not apply to
in-page untrusted code, and that, to the extent it protects us from other
origins at all, Site Isolation already provides for free.

### Why staying non-isolated is defense in depth

The suppression of timing primitives rests on two independent layers, and
keeping the page non-isolated is the lower of the two.

- Layer A, the SES allowlist. The compartment that runs pattern code is built
  from an explicit allowlist of globals, rather than by hiding things from the
  host global object. The relevant primitives are simply never put on the list.
  `performance` is a host API rather than a core language intrinsic, so it is
  absent from a fresh compartment unless endowed, and it is not endowed.
  `Worker` is not endowed either, so a pattern cannot spawn the second thread
  that the counting-thread timer needs. See
  [`runtime/runner/src/sandbox/compartment-globals.ts`](../../../runtime/runner/src/sandbox/compartment-globals.ts).
- Layer B, the non-isolated page. Below the JavaScript level, a non-isolated
  document is one the browser will not give a working `SharedArrayBuffer` or
  shared `WebAssembly.Memory`, for any code in the page, no matter what. This
  holds even if Layer A has a hole, whether a missed endowment, a compartment
  escape, or an intrinsic path that hands back a shared buffer.

The two layers fail independently. If we enable cross-origin isolation we delete
Layer B, and the whole weight of denying the timer falls on the SES allowlist
being perfect forever. For a system whose entire premise is running untrusted
code in our own process, collapsing two independent layers into one single point
of failure is the wrong direction.

### Embedding untrusted cross-origin iframes

We expect to eventually embed untrusted content from other origins in iframes.
The instinct that "now we surely need isolation" is understandable and still
incorrect for this threat model. Three facts settle it.

- The process boundary we want from embedded origins is already free. When we
  embed a third-party iframe, which is a different origin and usually a different
  site, the browser's default Site Isolation puts that frame in its own renderer
  process, whether or not our top document is cross-origin isolated. We do not
  need to become isolated to be separated from the code we embed. The Spectre
  direction reinforces this. An embedded frame in its own process can only
  time-read memory in its process, so it cannot read our memory regardless of
  what clock it builds.
- Non-isolation is a tree-wide cap on the timer. A document is cross-origin
  isolated only if its entire chain of ancestor documents is also cross-origin
  isolated. A nested frame can never be isolated if the top-level document is
  not. So keeping our top document non-isolated guarantees that no frame
  anywhere in the tree, at any origin, can obtain `SharedArrayBuffer`, shared
  `WebAssembly.Memory`, or an un-clamped clock. The single decision that denies
  the timer to our same-origin patterns also denies it to every untrusted origin
  we embed, with no per-frame configuration.
- Flipping to isolated would both widen the timer surface and fight the
  embedding goal. Becoming isolated re-arms the timer in our own page, and any
  embedded frame that opted into a COEP of its own would itself become isolated
  and gain the timer. On top of that, a require-corp COEP would block embedding
  arbitrary third-party origins unless they send `Cross-Origin-Resource-Policy`,
  which they will not, forcing a move to credentialless embedding just to keep
  embedding working at all.

So embedding untrusted origins makes the case for staying non-isolated stronger
rather than weaker.

### Controls embedding requires

Making embedded untrusted origins safe is a separate problem from the isolation
question, and it is solved with different tools:

- The iframe `sandbox` attribute and a `Content-Security-Policy` `frame-src`
  allowlist, to constrain what an embedded frame may do and which frames may be
  loaded.
- A `Permissions-Policy` (the iframe `allow` attribute), to deny powerful
  capabilities to embedded frames.
- `Cross-Origin-Resource-Policy` on our own served resources, so an untrusted
  embedder cannot pull our resources into its own context.

If we ever want per-pattern origin separation, the move is to run each pattern on
its own opaque or unique origin so that the browser's origin boundary and Site
Isolation separate patterns from us and from each other. That is obtained
without cross-origin isolation, and our non-isolation status would still cap the
timer across the whole tree.

### A tension to track

This reasoning holds while the things we embed are untrusted. If we ever need to
embed a trusted component that legitimately requires `SharedArrayBuffer`, for
example a high-performance WebAssembly-threads module we control, that component
needs an isolated ancestor chain, which conflicts with this posture. The right
answer in that case is to host that specific component out of process under its
own isolated origin, rather than isolating our top document. This is a real
future tension, named here so it is not mistaken for a reason to flip the
top-level decision.

## How it is enforced

- Header site. The shell document and its assets are served by the shell router
  at
  [`runtime/toolshed/routes/shell/shell.index.ts`](../../../runtime/toolshed/routes/shell/shell.index.ts).
  A middleware there pins `Cross-Origin-Opener-Policy: same-origin-allow-popups`
  (a non-isolating COOP) and `Cross-Origin-Embedder-Policy: unsafe-none` on
  every response. The middleware runs after the route handler, so it overrides
  any header an upstream change might set.
- Regression guard. The test at
  [`runtime/toolshed/routes/shell/shell.test.ts`](../../../runtime/toolshed/routes/shell/shell.test.ts)
  asserts that the served document does not carry the isolating COOP+COEP
  combination. A future change that flips the app to cross-origin isolated will
  fail this test loudly.

## If a feature ever needs isolation

Nothing in the application currently depends on `SharedArrayBuffer`, `Atomics`,
or `crossOriginIsolated`. If a future feature really requires cross-origin
isolation, that is a change to this security decision rather than a routine
configuration tweak. It must be reviewed against the threat analysis above
first, because turning isolation on re-opens the high-resolution-timer surface
to untrusted patterns and, once we embed third-party frames, to every untrusted
origin in the frame tree.

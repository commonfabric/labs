# Verbs

A **verb** is an operation a pattern declares — a `Stream` property, an event
type in and a result type out — and the only way a pattern changes its own
state; an operator can write a piece's cells directly with `cf cell set`, which runs
nothing and which a recomputation may overwrite
([the read and write session](../workflows/reading-and-writing.md)).
These five documents cover driving one from the command line. They divide by
the question they answer, so start with the one that matches yours.

| Document | Answers |
| --- | --- |
| [The Verb Session](the-verb-session.md) | *What is this, and why is it shaped this way?* The tour: it defines pattern, piece, space, verb, handler and invocation, then walks a whole session against a real fixture in thirteen acts. Read it start to finish; it assumes nothing. |
| [An agent's entry](agents-over-the-cli.md) | *I have a space and a key, but no piece id — where do I start?* The discovery surfaces, what bounds each, and the conclusions an empty answer does not support. |
| [A verb session, measured](session-walkthrough.md) | *What does it cost, and what does it still owe?* The tour's session priced step by step — byte measurements, the code behind each answer, the caveats, and the gap list. Written for someone building on the surface or reviewing it. |
| [Verbs over the CLI](over-the-cli.md) | *What does a verb hand back?* The reference for declared results, piece references, and what a retry does and does not guarantee. |
| [An author's prose, over the CLI](prose-over-the-cli.md) | *How does a doc comment reach a caller?* The reference for which of the two documents a caller's tools read carries which sentence. |

The tour and the walkthrough describe one session, driven by one script.
`runtime/cli/integration/verb-session-demo.sh` runs it,
`verb-session-gaps.sh` asserts the same surface as pass/fail in CI, and
`deno task check-verb-session-sync` holds both documents to the demo: a `cf`
command either quotes a line the demo runs or carries a `# not in the demo`
comment saying why it cannot, and an act number must name an act the demo has.
The agent's entry is held to that script for the claim it is built on — step 12
asserts that the registry does not list a piece a handler created, and that the
piece reads on its own address regardless. Its remaining commands are not
quoted from the demo, so `check-verb-session-sync` does not cover them and they
are checked by review.

# Common Fabric: Inverting the Physics of Trust

The runtime, and why it is shaped the way it is.

## The inverted rule

Data is viral: free to replicate at perfect fidelity, and once given to
computation you do not control, access to it can never be revoked. With
data, more power means more danger. No computing platform has ever
grappled with that physics.

All networked software today runs on a trust model improvised in the
mid-nineties: data lives with the code that collected it, so you must
trust the software with your data. The industry has been patching around
that decision ever since with a handful of jury-rigged solutions: terms
of service, permission dialogs, silos. And the patches set the
industry's shape: data accumulates within a boundary at a rate
proportional to how much is already inside, which leads inexorably to
aggregators. Silos hold your data hostage and then rent it back to you;
we are all renters in our digital lives. The equilibrium is a handful of
maximally-used, minimally-liked products. It was tolerable because
software was expensive to make, and its makers were few, with
reputations at stake.

AI ends both conditions at once. Software becomes infinite (anyone can
produce it by asking), so the old gate, trusting the reputation of the
maker, stops scaling. Infinite software inside the same broken frame
gives you infinite islands. Not a continent. And all text becomes
executable: an agent reading your email treats any sentence in it as
potential instructions, which is why prompt injection is a property, not
a bug. The industry's mitigation, telling the model to please be really
sure not to get tricked, is not a security model. Every ceiling the
industry is hitting with agents right now (injection, permission
fatigue, agents that cannot be given real access to anything that
matters) is the same ceiling: sensitive data, untrusted input, and
network access cannot safely coexist under the current rules.

The fabric is a runtime built on the opposite rule: **the software is
untrusted, and safety attaches to the data.** Its unit of untrusted
code is the pattern: a small, bounded program. Three mechanisms enforce
the rule — all three built — and they add up to a distributed, trusted
microkernel for networked software in the AI era.

## In this repository

- the runtime
- a compiler that turns ordinary TypeScript into policy-checkable
  dataflow graphs
- the flow-checking machinery
- the sandboxing
- a reactive, multiplayer-by-default storage layer with keypair identity
- well over a hundred running patterns, including a live demonstration
  of prompt injection being structurally contained
  (`packages/patterns/cfc-agent-prompt-injection-demo/`)
- the verifiable-execution spec the attestation mesh will follow, and
  signed build provenance for every binary built on main

## Policies travel with the data

Every datum carries
cryptographically verified provenance (who and what created it) and
policies (where it may go, who may use it for what). Both travel with
every copy, and anything derived from the datum inherits its policies.
The effect is that how your data may be used is structurally aligned
with your interests, and stays aligned wherever the data travels.

The inversion attaches policies to data rather than code for a reason:
code is open-ended, inherently; a checker can only refuse what it cannot
prove, the conservative bargain every type system makes. Data is
close-ended, and a finite policy on a finite datum is exactly what a
checker can prove. Putting policies on data allows open-ended
possibilities without open-ended trust.

Concretely: a mail importer is ordinary code a stranger could have
written, and the OAuth token that can read all your mail is protected by
a four-line policy attached to the token itself:

- never logged
- never transmitted outside the attested fabric, not even to your own
  browser (your mail can render there; the token has no business there)
- sent only to the origin that minted it, google.com
- and only in the Authorization header

That is the whole list. Any code can handle the token safely, because
the danger is fenced by the data, not by the code's good intentions.

## Flow checking at compile time

Contextual Flow Control is type
checking for privacy policies: if the software compiles, it by
construction has no data flows that violate the policies. The taint
checker can refuse to run code if there is any possibility that data
could be used against its policies, and the error names the flow. So a
stranger's code, or code a model generated a second ago, can safely
touch your most sensitive data.

Rust programmers know the shape of this bargain: the borrow checker is a
bit of a nag, and the reward for satisfying it is code that provably has
no data races. Humans find such checkers a slog. Language models have
infinite patience: they are happy to grind against the checker until it
is satisfied, and whatever they come up with is safe by construction.
And because patterns carry no authority of their own, any pattern
anyone has already spent the tokens to make can be safely reused:
patterns are crowd-sourced, cached save points in the latent space of
software.

What makes the check tractable is the compiler: patterns are plain
TypeScript, and the compiler rewrites every closure to capture only the
fields it actually reads, so taint is tracked per field rather than per
pattern, and the full dataflow graph is known before anything runs. None
of this is hidden: `cf check <pattern> --show-transformed` prints the
exact code the runtime executes.

## A mesh of proven machines

Remote attestation lets any machine
prove, bit for bit, that it is running the open-source runtime, in
memory its own operator cannot read. Nodes refuse peers that cannot
prove it, so you can build a trusted fabric out of untrusted nodes: your
data may flow anywhere that can prove itself, and nowhere else. Identity
is a keypair, not an account, so state accretes at Schelling points —
and the durable ones form where no participant can hold the state
hostage.

Attestation is existing hardware pointed backward. Confidential
computing's most famous deployment was DRM: silicon built to run code
against the interests of the machine's own owner. Pointed the way it has
always been pointed, attestation proves to a media company that your
machine will keep secrets from you. Pointed the other way, it proves to
you that a stranger's machine is running exactly the open-source runtime
you would have chosen, before your data ever arrives. Captured enemy
artillery, wheeled around to face the other direction.

Nobody has used it this way because the obstacle is economic: an
attestation is only as strong as the ecosystem that checks it
(independent verifiers, transparency logs, reproducible builds), and
nobody stands up that ecosystem for one workload; a payments enclave is
not worth it. A general-purpose runtime that can run anything is a
different matter: verify the runtime once, and every pattern that ever
runs on it inherits the verification.

## Four classes of cloud security

There are four classes of cloud security:

1. Cloud apps: couch surfing in someone else's apartment. The host can
   do whatever they want.
2. Cloud VMs: renting an apartment. The landlord can come in, but only
   in an emergency.
3. Trusted execution environments: an embassy. Snooping would be an act
   of war.
4. ZK proofs: a volcano lair on a remote island. Society would have to
   have broken down.

Each class is an order of magnitude better than the last, and the vast
majority of the cloud today is in the first two. Moving most computing
to the embassy class would be a massive improvement — and the class gets
stronger with every hardware generation. Real embassies can be breached,
but breaching one is a nation-state act, and that is the right size for
what the enclave buys. It also buys something the lower classes cannot:
mutually trusted private infrastructure, a place where parties who do
not trust each other can still share computation, because each of them
can verify what runs there. The architecture does not need enclaves to
be perfect: the flow checking stands with no enclave in sight, a broken
enclave exposes only what flowed through that node while it was broken,
and attestations from independent silicon can be required k-of-n.

Nothing in this design requires a token, a chain, or a consensus
mechanism. The requirement is only that trust be derivable, not
declarative: checkable by anyone, from evidence.

## A hotfix, not a law of gravity

The rule being inverted is younger than it feels. The same-origin model
arrived as a hotfix, decided by the Netscape team to handle an early
JavaScript security problem, and because it was a reasonable simplifying
policy it hardened until it felt like a law of gravity. But unlike a law
of gravity, it can be changed. We made it; we can change it.

And there is precedent for routing around a security model: when the web
exploded, it invalidated Windows 95's security model, no amount of
patching a monolithic kernel could make it safe, and the industry moved
to NT, a kernel with the boundary designed in from the start.

This is buildable now because two ingredients arrived almost at once. Secure enclaves make trust across a
network possible. And language models write software for approximately
free; a new framework used to mean convincing humans to write for an
empty ecosystem, and now models will happily write for it. The standard
objection, that nobody will rewrite everything, has expired. Language
models are the cause of and the solution to the security problem of
infinite software.

## Resonant by default

All of this machinery is for one thing: how software feels to live
with. Hollow things are things you like, but
afterwards you are left feeling regret. Resonant things are things you
like, and afterwards you feel nourished. They are superficially similar
but fundamentally different. Modern society — modern tech, modern
business, modern politics — is great at delivering hollow experiences
and terrible at delivering resonant ones; the aggregator equilibrium,
maximally-used and minimally-liked, is hollowness as a market outcome. AI supercharges everything, so it is more important than
ever that software become resonant by default. And to do that, you need
to invert the physics of trust.

[Resonant computing](https://resonantcomputing.org), a manifesto we
co-authored, names five principles. The inversion gives each one
teeth:

- **Private.** Policies on data make people the primary stewards of
  their own context, determining how it is used.
- **Dedicated.** Flow checking proves at compile time that your data
  serves no interest but yours: every flow out of your context is
  either policy-permitted or a compile error.
- **Plural.** No single entity controls the digital spaces we inhabit:
  identity is a keypair, and the mesh has no center.
- **Adaptable.** Infinite software, safe by construction — open-ended
  enough to meet each person's actual needs.
- **Prosocial.** Multiplayer is the substrate default, and collective
  signals carry the policies of the people who generated them: no
  intermediary can own what a group made together.

## From cells to a city

Life did this with dangerous chemistry: put it in cells. The
mechanisms above are the membrane, and what they make possible is
patterns: policy-checked, provenance-carrying, unable to leak what they
touch. A
single one is unimpressive: a screenshot of any one running pattern
looks like almost nothing, the way any single web page looked like
almost nothing in 1994. The point of the web was never a page; it was
the emergent whole, the ability to teleport anywhere. The same is true
here. Because policies survive derivation, patterns compose: any two
that check can be joined, and the joint result still checks; no trust
negotiation required. As more patterns accumulate,
they transmute into something radically different, with emergent power
that makes the individual patterns look puny: a general-purpose
material that can be shaped into nearly anything. The patterns are the
cells; the fabric is the organism.

Infinite software will not be infinite apps; it will be one system that
does infinite things. The software melts away, and it feels like your
data coming alive — something that lives with you. Alive not like a
person, with one face you can talk to,
but like a city. A whole city of cognitive labor that works just for
you.

## The whole unlock

Software is alchemy: something outside ourselves that extends our
agency. And data compounds — every source combined with every other
multiplies what the alchemy can do. That is an enormous store of
potential for humanity, and almost all of it is still locked in silos
guarded by goblins: for forty years we have structurally underproduced
software, because it was expensive to create, and walled off what we
did produce, because the trust model allowed nothing else. Personal computing was supposed to make
computers personal; instead, it made people subordinate to software.

LLMs make software infinite. But infinite software on the wrong
substrate does not change the world; it just makes more islands. On the
right substrate it becomes the way back: a personal fabric that
everyone can own, woven into a society-scale common fabric. If the
singularity comes, let it be plural: exuberant, creative, messy —
billions of experiments in flourishing, not one experiment in
species-wide management.

And none of it works without the inversion. The fabric has your
intentions woven in, structurally guiding what it can and cannot do —
not as some hastily jury-rigged solution on top. Inverting the physics
of trust is the whole unlock.

## Where things stand

The layers are at different stages, and each is useful without the ones
above it. The runtime, the compiler, and the sandboxing work today. The
flow checking runs, enforcing at explicit boundaries by default and
hardening toward strict; the trusted base is still larger than the
microkernel it is meant to shrink to, and shrinking it is part of the
work. Confidential hardware is provisioned and every release binary
carries signed provenance; the attestation protocol that would let a
peer refuse an unproven runtime is specified in
`docs/specs/verifiable-execution/` and not yet built. The semantics are
in place; robustness and performance are not yet, and they are the
current work. That is the ordinary condition of a young kernel.

`docs/tutorial/` walks the mechanisms; `packages/patterns/` is where to
start.

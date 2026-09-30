Software is alchemy. Combine data with code and something appears that
was not there before, and the more of it you can combine, the more the
result is worth. That is the whole promise, and forty years of it is
still locked in silos, guarded by goblins.

We are all renters in our digital lives. Your data lives on someone
else's machine, under someone else's rules, and the only lever you have
is asking nicely. Our personal context got shattered into a million
pocket universes, one per app, and the walls between them are the
product: these are my users, and anyone who wants to talk to them pays
my toll. We live in windowless silos to be safe. But that is antisocial,
and the value forfeited is combinatorial — every pair of things that
never got to meet.

The trust model everything runs on says: hand your data to the software, 
and trust the software. Data accumulates inside a boundary at a rate 
proportional to how much is already inside. The entity that is supposed 
to be working for you ends up holding power over you.

Our current physics of trust are insanely hard to navigate, even for
professionals. Our current physics of trust are dangerous by default.

The patches never addressed it, because they could not. A permission
prompt is responsibility laundering — technically you consented, and the
consent is hollow, and the company you consented to may belong to
somebody else in five years. Each patch is another epicycle on a model
that has the wrong thing at the center. The same-origin model orbits the
code. It should orbit the data.

The arrangement is not a law of nature. Inverting it means new software
all the way down, and until recently nobody could afford that. Two
ingredients changed it. Secure enclaves — silicon originally built to
run against the interests of the machine's owner, pointed the other way
— mean a machine you do not own can prove what it is running before your
data ever reaches it. And language models write software for
approximately free, so a new framework no longer means convincing humans
to write for an empty ecosystem.

So we built a runtime on the opposite rule. The software is untrusted,
and safety attaches to the data. Every datum carries its own policies,
and anything derived from it carries them too. Code that cannot prove it
honors those policies does not compile. What it adds up to is a
distributed, trusted runtime for networked software in the AI era.

Concretely. A program that imports your mail gets a token that could
read all of it. In Common Fabric that token carries four lines: never
logged, never leaves the verified runtime, only ever sent to the one
place that issued it, and only in the one field that place expects. That
is the whole list. Any program can hold that token now, including one a
model wrote thirty seconds ago, because the rules ride with the data
instead of with the program's good intentions. In Common Fabric, how your
data may be used is structurally aligned with your interests — not
promised to be, or audited to be. Structurally.

The hard part is not restriction. It is release. Rules only ever
tighten: combine the mail with the calendar and the result is as
restricted as both, and soon nothing can leave at all — the summary of
your mail cannot go to your accountant, because the mail could not. That
is how systems like this actually fail: not by letting something
through, but by growing so cautious that nothing useful can be done. So
a rule can be relaxed on purpose — this summary, to that accountant — as
an explicit decision at a boundary: one that rides in a rule the data
itself carries, or in a record that can be revoked, and whose evidence
ordinary code cannot manufacture. Who may make that decision, and
where, is the part most worth getting right.

What that buys is not a better app store, and not the long tail
either. Cheap code gets you niche tools, and that was never the
constraint that was binding. The obvious software does not exist, and
cost is not why. A genuinely good shopping list. A household that runs
itself. A plan four people can hold at once. An assistant that knows
what you know. Whatever fits inside one silo, somebody has built. What
is left is everything that spans them, and spanning them is exactly
what the old rule could never make safe.

Take the household, since everyone has one. Four people; two calendars
that do not talk to each other; a school that emails one parent and a
doctor who texts the other; a shared card nobody reconciles; a list on
the fridge. Each of those is solved inside its own silo. What nobody has
built is the thing that sees all of it at once and acts: notices the
appointment and the pickup collide, moves what can move, tells the
person who needs telling, adds what the appointment needs to the list,
and does it while nobody is looking. It does not exist because it would
have to read everything, and under the old rule that means trusting it
completely — and nobody should trust a program written last Tuesday that
far. The hard part was never the logic. It is that the program is
unsafe. Fence the danger with the data instead, and it becomes a program
a model can write and a household can leave running.

That is the shape of the mismatch. Software is sliced vertically, one
application at a time. Lives run horizontally, across all of them at
once. And almost nothing that matters to a person is theirs alone: the
trip, the household, the band, the argument with a sibling that has
been running for a decade. "Our" has never been a real possessive on a
computer. It has only ever been a label on someone else's storage,
revocable whenever the owner of that storage decides. We think that is
a large part of why social computing stalled at broadcasting to each
other and never reached making things together.

Where it compounds is software that passes between strangers. Today
everyone building their own software gets an island. Here programs stop
being monuments and become crowd-sourced, cached save points in the
latent space of software: some rando sneezes, and what comes out is a
thing you can run on your real data, because the substrate is what
keeps you safe rather than the author's good name. Code flows to the
data instead of data flowing to the code. What accumulates in a
close-ended system gets trapped. In an open-ended one it blossoms.

[The full argument](./inverting-the-physics-of-trust.md)
is the physics and the hardware.

Most of what is here is early, and all of it is readable. What runs
today: the compiler; the checker, rejecting at explicit boundaries — the
third of four rungs — in every host and test, with no flag set; a
hundred and twenty-odd patterns with recorded baselines; labels that
survive into the store in the browser shell; row-level clearance on
shared tables; and access control on spaces, enforced on the production
server. Every dial the flow checker has is built, and the harness that
dogfoods it runs the full set. What is left is mostly wiring: the
stricter dials are off in the core preset while they roll out,
strict-by-default is the current work, a space still has a host that
can revoke a participant, and the machine that would prove which
runtime it is before your data arrives is provisioned but not yet
proving anything. Robustness and performance are not there yet. The
claim is never perfection. It is checkability: here is the mechanism,
here is how to check it, here is what it does not cover. A promise of
perfection is destroyed by its first counterexample; a guarantee built
to be checked survives being found wanting. The people who came before
us settled arguments like this one by writing code rather than papers,
and we would rather be judged the same way.

Nothing here needs a token, a chain, or a consensus mechanism — only
that trust be checkable by anyone, from evidence.

Same-origin was a hotfix. It got hardened until it felt like a law of
gravity, but people made it in a hurry, and people can replace it. We do
not know whether we are the ones who will. Language models make software
infinite, and infinite software inside the same broken frame gives you
infinite islands — not a continent. The substrate is the part that
decides which one you get, and that is where we are spending our shot
rather than waiting for somebody else to.

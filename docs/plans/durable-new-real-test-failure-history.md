# Durable history of new real test failures and a bounded aggregate

Status: built. What remains is the check the first publisher run after it
lands answers, which [What remains](#what-remains) describes. When that is
done this plan is archived.

The test-selection publisher scores each test by its new real test failures:
failures that say something about a change rather than about the test or its
environment, which on the default branch means a later commit fixed them. They
accumulate over unbounded history, and the only place they live is the
publisher's rolling aggregate, the state object each run writes beside its
manifest. [The operating guide](../development/test-selection.md#the-publisher)
describes the publisher. This plan makes that history survive everything the
publisher and the store do to it, and stops the aggregate growing with the age
of the store.

## What was wrong

Each of these was verified against `main` and the store on 2026-10-01.

**A bootstrap discarded every new real test failure older than its window.**
A bootstrap folded into an empty aggregate. The store's history starts on
2026-08-19, so a bootstrap with the sixty-day default window still reached
all of it on 2026-10-01. From 2026-10-18 it would not, and every new real
test failure before its window would be lost. The recovery procedure no
longer reaches for a bootstrap where any stored aggregate reads, but two
things still forced one: a store holding no aggregate, and a store whose
every aggregate is a body that is not an aggregate at all.

**New real test failures of renamed tests were stranded.** The publisher
resolves each record it reads through the alias file, but not the history it
has already folded. An alias line added after the old name's records were
folded left their new real test failures under the old name, which nothing
records any more, until the test was dropped as one the tree no longer
holds. The aggregate of 2026-10-01 held history for 1,265 tests under a name
an alias line has since replaced, with 89 new real test failures on 53 of
those tests.

**The list of folded objects grew without bound.** The aggregate names
every object it has folded, so that no later run folds one twice. On
2026-10-01 that was 388,595 names, 43.6 MB of the aggregate's 154 MB, and
growing by about 9,000 names a day. The number of tests did not grow
without bound: a test the tree no longer holds is already dropped once no
run of it is recorded inside the windows a state keeps.

The figures come from reading the newest state object in the public store
and from folding it offline with the code this plan describes.

## The design

**Date every new real test failure.** Each test's state keeps its new real
test failures by the day each is dated to, as well as the totals it already
kept. A new real test failure is dated to the day of the failure it credits.
Storing the day is a change to what a new real test failure is attributed
to, so the change raises `NEW_REAL_TEST_FAILURE_RULE`. The first run after
it folds the whole history again from the records, which dates every new
real test failure exactly. The totals stay in the stored form beside the
days, and are read back from them, so the two always agree.

**A bootstrap never runs over history.** It reads the stored states newest
first, of any day, and refuses if any of them is an aggregate this publisher
can read, naming it, and naming the `days` window that reaches it where
newer states that do not read stand in front of it. An incremental
run folding onto that aggregate keeps every new real test failure it holds
and reads from the last day it read, which is everything a bootstrap would
have read. A bootstrap starts from nothing only where no state any publisher
can read is stored, and refuses where none reads and one is written in a
shape from further ahead. It closes every day before its window, so no later
run folds those days out of order.

**Resolve folded history through the alias file on every run.** A run
moves each day of a state's history to the name a record of that day
resolves to, exactly as it resolves the records it reads. The days before
an alias's date move to the new name and are added to what it already
holds; the days from that date on stay.

**Close read days.** A day closes once it has been read, every day before it has
been read, and it is `COMPACTION_LAG_DAYS` behind, the point at which the store
stops expecting late arrivals for it. The aggregate then records the last closed
day instead of the names of the objects up to it, apart from those of the first
day the history holds, where a fold of the whole history begins. An incremental
run reads from the last day its aggregate read, however far back, so a stopped
publisher catches up on its next run and no day is left unread.

**Let old states expire.** A bucket lifecycle rule deletes every object
under `labs/test-selection/` 45 days after it is created. That costs no
history: every run writes a new aggregate carrying each new real test
failure forward, so only a publisher stopped for 45 days would leave none,
and the publisher is not expected to stop for more than a week. Records
under `labs/test-records/` are kept permanently, so even then a bootstrap
with a `days` window reaching the first day of the store's history counts
everything again.

Folding the aggregate of 2026-10-01 forward offline, dating, resolving and
closing it, kept every one of its 7,995 new real test failures, moved the 89
new real test failures of renamed tests, and left 9,835 object names. The
first day of the store's history, 2026-08-19, has a rollup, so keeping that
day adds a receipt rather than its 1,688 objects. The aggregate came to
109 MB. What remains grows with the number of tests and with the days each
had a new real test failure on, rather than with the number of objects the
store holds. The first run after this lands folds the whole history
again under the rules in force, so its counts are the ones those rules
give.

## The work

- [x] Date new real test failures.
- [x] Refuse a bootstrap over a store holding any aggregate a publisher
      can read.
- [x] Resolve folded history through the alias file on every run.
- [x] Close read days, and read from the last day read.

## What remains

- [ ] Confirm from the first scheduled publisher run after this lands that
      it logs that it folds every day from the first day of the store's
      history again, that it finishes inside its job, and that the state
      object it writes is smaller than the one before it.

Rolling this back loses nothing. A state this publisher writes is stamped
with a `NEW_REAL_TEST_FAILURE_RULE` an older publisher does not use, so the
older publisher folds the whole history again, from the first day it finds
among the objects the state names, and the state keeps the names of the
first day the history holds for that reason. Rolling forward again folds the
whole history once more, for the same reason. Each costs one long run. The
shape number stays where it is, because raising it would leave every lane
on a branch behind the raise unable to read the manifests published after
it.

Out of scope here, and recorded on the team's topics board: 36 new real test
failures on the aggregate of 2026-10-01 stay under replaced names because they
are dated on or after their alias's date. That count comes from the offline
fold, which dated each new real test failure of an aggregate stored without days
to that test's most recent one, so some may be dated later than they happened;
the fold of the whole history the raised rule asks for dates them exactly.
Records under a replaced name keep arriving for days after the alias's date,
which suggests alias lines are dated before the rename reaches `main`. Whether
an alias should apply by the day its line landed rather than the day it names is
a question about the record format, not about the aggregate.

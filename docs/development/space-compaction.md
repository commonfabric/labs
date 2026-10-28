# Compacting a space's history on a host

A **compaction** rewrites one space's SQLite store: for each selected
document, the revision rows and snapshots behind its current value are
deleted and the oldest kept row becomes its base, attributed to the
compaction commit: a `patch` is rewritten as a `set` holding that value, a
`set` or a `delete` keeps its operation, so a deleted document stays
deleted; the payload of every commit older than a retention window is
replaced by a marker, except commit 1's, the commits an `op_*` row
references, and the compaction commits' own. Every commit row stays. The
compacted file keeps none of what was removed; it lives on in the archive the
operator takes first, and, until the operator retires it, in the original
file the swap moves aside for rollback.
[`docs/plans/compact-space.md`](../plans/compact-space.md) is the design and
the reasons; this is the procedure, as it was rehearsed on a clone of the
Topics space's 2026-10-09 snapshot, written for the operator who will run it
on Estuary.

Two neighbors:

- [`space-clone-rehearsal.md`](space-clone-rehearsal.md) makes the writable
  copy the rehearsal runs on. Read it first; a compaction that has not been
  rehearsed on a clone is not run on a host.
- [`staging-space-copy.md`](staging-space-copy.md) is how a space's file is
  snapshotted, moved aside and installed on a host. The swap below is its
  steps 5 through 8 for one instance.

The tool is `cf space compact`, described in
[the CLI README](../../packages/cli/README.md#compacting-a-space-store). Three
things about it decide the shape of everything below. It rewrites a store in
place and writes the result as a fresh file, so it runs against a **copy of
the backup**, never the backup and never a served file. It **refuses** a store
whose schema the engine would migrate on opening, a store with a second branch,
foreign-key violations, more than one ACL document, or a `-wal` beside it, and
a result path that exists or sits in a served directory, so a refusal is a
message to read and not a thing to route around. And its `--verify --against`
is a second implementation of what the run claims, run on the result and the
backup, which is the step that stands between the result and the install.

## Before anything is stopped

The space's owner has agreed to the compaction and to the archive's retention.
The history being removed is theirs; the tool refuses nothing on that ground
and the plan's ["What a user sees"](../plans/compact-space.md#what-a-user-sees)
says what the space shows afterward.

The clone rehearsal below has passed, on a snapshot of the space taken within
the last few days, with the flag set the host run will use. The rehearsal's
dry-run report is at hand to compare with the host's.

The release every serving instance runs includes the compacted-basis guard
(stage 2 of the plan, [labs#8643](https://github.com/commonfabric/labs/pull/8643),
merged as `174fc11ad2`), and the host's `cf` has `cf space compact` (stage 4,
[labs#8722](https://github.com/commonfabric/labs/pull/8722), `08a6c667dc`).
Neither the rehearsal nor `--verify` establishes either: both run a checkout
on a laptop, and Estuary runs whatever ref was last deployed to it, which is
not main. An engine without the guard reopens the result without complaint,
since the schema is unchanged, and takes a basis the compaction removed for a
genuine absence, accepting a stale write through the identity exemption. The
check is each instance's `/api/meta`, whose `gitSha` names its release; a
release is current enough when the guard's merge commit is its ancestor. An
instance that does not answer within the bound, or answers without a
40-digit `gitSha`, prints `NONE` and fails the check; the count at the end
must read 21 of one sha before anything below is run:

```bash
# On the host: every instance names its release, or the check fails loudly.
for p in $(seq 8001 8021); do
  sha=$(curl -s --max-time 5 "localhost:$p/api/meta" | grep -o '"gitSha":"[0-9a-f]\{40\}"' | cut -d'"' -f4)
  echo "$p ${sha:-NONE}"
done | tee /tmp/releases.txt
awk '{print $2}' /tmp/releases.txt | sort | uniq -c   # exactly one line, "21 <sha>"; a NONE or a second sha = stop here
cf space compact --help    # on the host: an older cf has no such command

# On a checkout with main fetched, with the one sha that line named
# (quoted: a bare <sha> placeholder is a redirection to the shell).
RELEASE='<the sha the instances named>'
git merge-base --is-ancestor 174fc11ad208692c68337ee93732dea252811fa8 "$RELEASE" \
  && echo guard-present || echo guard-ABSENT-deploy-first
```

A release that fails the test is deployed first, through the `deploy-estuary`
workflow ([`deploying.md`](deploying.md)), which ships one commit's toolshed
and `cf` binaries together, and the check is run again after it. The ref
deployed on 2026-10-13, `2de2c1095bf0`, carried stages 1 through 3 and not
stage 4, so for the first host run this deploy is step zero.

## The rehearsal

```bash
# A snapshot of the live file, taken while the space is still served: fine
# for the rehearsal and the dry run, not for the file that gets compacted.
# On the host, into a directory with room (/tmp has none; see the staging
# copy document), then copied down and checksummed.
sqlite3 -readonly '/data/memory/engine-v3/engine-v3/<did>.sqlite' \
  "VACUUM INTO '/data/replaced/<did>.dry-run-<date>.sqlite'"

# Clone it, as space-clone-rehearsal.md says. Keep the working path it prints.
deno task cf space clone <did> --from <snapshot> --to ~/clones/<name>
CLONE=~/clones/<name>
WORK=$CLONE/engine-v3/engine-v3/<did>.sqlite
PRISTINE=$CLONE/pristine/<did>.sqlite

# 1. Plan. Read the report; the `schema` line says whether a run would write
#    this store at all.
deno task cf space compact "$WORK" --documents computed: --dry-run

# 2. Compact the WORKING copy. The result lands beside it unless --out says
#    otherwise; the pristine copy is the clone's own backup and is not touched.
deno task cf space compact "$WORK" --documents computed: \
  --out ~/clones/<name>-compacted.sqlite

# 3. Verify the result against the pristine copy. Exit code 1 on any failed
#    check; the report names the property the result lost.
deno task cf space compact ~/clones/<name>-compacted.sqlite \
  --verify --against "$PRISTINE"

# 4. Serve the result and read it. Clone it (the clone keeps the DID; HOST
#    pins it to loopback), start a toolshed on the workspace's port offset,
#    open the Topics board cold, read the board and a handful of topics
#    through cf, comparing cold/warm read times and the patchReplays delta
#    with the uncompacted baseline. The computed-only selection leaves
#    authored history, so the global replay counter can still rise.
#    The write timings below measure engine patch commits. Measure a topic
#    edit through the served API separately to measure its round trip.
deno task cf space clone <did> --from ~/clones/<name>-compacted.sqlite \
  --to ~/clones/<name>-compacted
HOST=127.0.0.1 MEMORY_DIR="file://$HOME/clones/<name>-compacted/" \
  ./scripts/start-local-dev.sh --port-offset <N>
```

Only a flag set that passed on the clone is run on the host, and the host run's
dry-run report is compared with the clone's before anything is written.

### What the 2026-10-12 rehearsal measured

On a clone of the Topics space's 2026-10-09 snapshot (22.71 GB, 2,482,226
commits, 3,741,969 revision rows, 1,195,660 heads), on a laptop, with
`--documents computed:` and the default cut and window:

| Step | Took | What it said |
| --- | --- | --- |
| `cf space reset` of the clone | 35 min | content matches baseline |
| dry run | 56 s | 384,602 instances matched, 232,853 lose rows, 2,064,934 revision rows (688.9 MB) and 1,552 snapshots to delete, 2,415,215 payloads (13.02 GB) to hollow, schema current |
| compaction | 298 s | the plan's counts exactly; result 8.45 GB |
| `--verify --against` the pristine copy | 50.5 min | 24 checks passed: every head at its address, 1,195,660 documents identical through the inspector's replay, 232,853 materialized boundaries equal to the backup's exact-row state, 2,415,215 markers hashed against the backup, fingerprint equal, 11 non-history tables identical |

The compaction's time is the instance pass, at roughly 20,000 instances a
minute, plus a hollowing pass over every commit row; the verification's time
is two full reconstructions of every head and a hash of every hollowed payload,
which is the price of the claim it makes. `--verify-sample` is the quick pass
while flags are still being chosen.

Served from a clone of the result on a laptop toolshed, read through `cf`,
against the same reads on the uncompacted snapshot with the same engine
(stage 1 of the plan):

| Read | Uncompacted | Compacted |
| --- | --- | --- |
| Topics board, cold | 20,213 ms | 15,504 ms |
| five topics, cold | 690–1,431 ms | 588–857 ms |
| board again, warm | 10,073 ms | 8,201 ms |
| patch replays after the cold board load | 44,928 | 14,273 |
| one patch on each of the six longest-tailed documents, through the engine | 1–5 ms | 1–5 ms |
| a topic title edit through the served API, via `cf cell set`: the cold edit of each of two sessions, then the median and range of seven warm edits | 9.0 s and 9.2 s cold; 2.7 s (2.6–3.1 s) warm | 10.7 s and 8.9 s cold; 3.3 s (2.8–3.7 s) warm |
| the same edit's server `transact` frame (`CF_SLOW_QUERY_THRESHOLD_MS=0`), five edits a side, then five more with a browser's board session holding its watch | 4, 3, 2, 6, 5 ms; then 3, 3, 2, 6, 2 ms; the board session's refresh per edit 2–3 ms | 2, 6, 6, 2, 2 ms; then 2, 1, 1, 1, 1 ms; refresh 1–2 ms |

The board's cold load is a traversal over 21,901 documents either way, which
compaction does not touch; the replays that remain come from the authored
documents the selection left alone. The engine's write timings were already
below the storm's 180 ms after stage 1's bounded base search, and stay there;
after compaction the longest tails in the store are authored documents, since
every compacted instance is down to its one row. The edit through the served
API, read as `cf`'s round trip, is seconds on both files, and the seconds are
a watch add, not the write — and a broad one: the session's request of 932
watches delivering 5,613 documents (6.4 s on the uncompacted file, 7.2 s on
the compacted; `stage6/health-after-edit{,-baseline}.json`). The single-topic
watch in those same sessions, one watch delivering 314 documents, took
214–224 ms; the follow-up's edit sessions registered only that single-topic
watch and, after a board read had warmed the documents, it took 31–105 ms on
either file. The two widths are not one request, so the seconds say what the
broad watch costs, not what warming saved. Read where the storm record's 180 ms was read, as the server's
`transact` frame with the slow-query threshold at zero, the write is 2–6 ms
on both files with no lock wait, and with a browser's board session holding
its watch while the edits land it is 1–2 ms compacted against 2–6 ms
uncompacted, the board session's refresh 1–2 ms against 2–3 ms. The plan's
"no slower" acceptance check for the served edit is **closed** on that
instrument (2026-10-13; the compacted file ran first each round, so the
laptop's wall clock, 0.9–1.3 s a round trip against 1.4–3.0 s, is reported
and not relied on). What the compaction buys is
the file: 8.45 GB where there was 22.71 GB, and a history that no longer
grows a reader's work with every storm.

### What a browser's board page costs, which `cf` understates

The shell's board page, loaded cold in a browser against the same two files
(2026-10-13, threshold zero), is a different workload from the `cf` read
above. Its first watch is the same 20,567 upserts over 20,489 reads (7.7 s
on the compacted file; the page renders right after), but the page then
hydrates its 934 cards with a second wave of 6,577 watches delivering 84,220
upserts over 103,426 reads (14.3 s compacted, 30.8 s uncompacted), followed
by a refresh across 23,414 watches (8.4 s). The server reads 111,758
documents for one load, past the document cache's 65,536-entry cap (46,222
evictions), and on the uncompacted file `/api/health/stats` did not answer
within ten seconds while the wave ran: the storm record's pegged instance,
from one page. Compaction halves the server's work for that load (watch adds
61 s to 24 s in all) and moves nothing else: the width is the pattern's
declarations, and a `cf` read of the board's computed `index`, the Topics
skill's bounded survey, runs the pattern in the CLI and leaves 936
session-scoped `computed:` instances behind as 936 commits. The first browser
load also wrote ~930 topic patches, the index link-bind the pattern README
calls a one-time rewire; a reload wrote one commit.

## The host run

Twenty-one systemd instances `toolshed-binary@8001` through `8021` serve
`/data/memory`; nginx routes a space's websocket to one of them by a consistent
hash of the space DID, and the Topics space hashed to port 8020 in October
2026. Every instance can open every file, though, and a stop of the one the
hash names does not establish that the others have released this one — so the
recipe stops all twenty-one before the authoritative backup and the swap, as
the staging copy does, and starts them all after. The space is down for the
window either way; the other spaces are down with it, which at a quiet hour
costs less than a write landing on a file that is about to be replaced.

Steps 2, 6 and 7 carry `sudo` and are the operator's to run by hand. The window
in which the space is down is steps 2 through 7, and the backup that becomes the
replacement is taken inside it: a snapshot from before the stop would silently
drop every commit accepted between the two, and verifying against it would not
show the gap.

```bash
# 0. Space, disk, which instance owns it, and the release each instance runs
#    (the guard check above, again: a deploy between the preflight and the
#    window would move it). Do not trust the record; check.
df -h /data
ls -la /data/memory/engine-v3/engine-v3/ | grep '<did>'
curl -s localhost:8020/api/health/stats | grep -c '<did>'
for p in $(seq 8001 8021); do
  sha=$(curl -s --max-time 5 "localhost:$p/api/meta" | grep -o '"gitSha":"[0-9a-f]\{40\}"' | cut -d'"' -f4)
  echo "$p ${sha:-NONE}"
done | tee /tmp/releases.txt
awk '{print $2}' /tmp/releases.txt | sort | uniq -c   # exactly one line, "21 <sha>"; a NONE or a second sha = stop here

# 1. Dry run against a LIVE snapshot, with the instance still serving, and
#    compare with the clone rehearsal's report. This snapshot is for the
#    numbers only; it is not the one that gets compacted.
sqlite3 -readonly '/data/memory/engine-v3/engine-v3/<did>.sqlite' \
  "VACUUM INTO '/data/replaced/<did>.dry-run-<date>.sqlite'"
cf space compact '/data/replaced/<did>.dry-run-<date>.sqlite' \
  --documents computed: --dry-run

# 2. Stop every instance. (sudo.) Nothing writes any space from here on.
for p in $(seq 8001 8021); do sudo systemctl stop toolshed-binary@$p; done

# 3. The authoritative backup, AFTER the stop: read-only, into a directory
#    with room, checksummed. This is the rollback, the archive, and the source.
sqlite3 -readonly '/data/memory/engine-v3/engine-v3/<did>.sqlite' \
  "VACUUM INTO '/data/replaced/<did>.pre-compaction-<date>.sqlite'"
sha256sum '/data/replaced/<did>.pre-compaction-<date>.sqlite'

# 4. Compact a COPY of the backup — the backup itself is never written to —
#    and write the result beside it. The dry-run report printed first must
#    agree with step 1's up to the commits accepted between the two snapshots.
cp '/data/replaced/<did>.pre-compaction-<date>.sqlite' /data/replaced/<did>.work.sqlite
cf space compact /data/replaced/<did>.work.sqlite --documents computed: \
  --out '/data/replaced/<did>.compacted.sqlite'
rm /data/replaced/<did>.work.sqlite

# 5. Verify, on the host, against the post-stop backup.
cf space compact '/data/replaced/<did>.compacted.sqlite' \
  --verify --against '/data/replaced/<did>.pre-compaction-<date>.sqlite'

# 6. Swap. Move the live file ASIDE with its companions, never delete; install
#    the result owned by deploy. (sudo.)
cd /data/memory/engine-v3/engine-v3/
ls -la '<did>.sqlite'*
sudo mv '<did>.sqlite'* /data/replaced/
sudo install -o deploy -g deploy -m 644 '/data/replaced/<did>.compacted.sqlite' '<did>.sqlite'

# 7. Start them all, confirm, read back. (sudo.)
for p in $(seq 8001 8021); do sudo systemctl start toolshed-binary@$p; done
for p in $(seq 8001 8021); do systemctl is-active toolshed-binary@$p; done
```

After the start, the two checks the staging copy document ends with: the space
is listed, and a read through the API returns the content.

## Rolling back

The procedure never deletes the original: step 6 moves it aside with its
`-wal` and `-shm` companions into `/data/replaced/`, and installs the result
under its name. Rolling back is the swap in reverse, and once step 7 has run
it begins with the stop again: every instance has the result open and may be
writing it, and by then the result has companions of its own. A file moved
out from under an open database replaces nothing, since the instances keep
the old inode, and a `-wal` left beside a restored original would be replayed
into it on the next open. Write these commands down before anything is
stopped. The backup is a second copy of the same pre-compaction state should
the original be damaged in the move.

```bash
# 1. Stop every instance and confirm each has stopped. (sudo.)
for p in $(seq 8001 8021); do sudo systemctl stop toolshed-binary@$p; done
for p in $(seq 8001 8021); do systemctl is-active toolshed-binary@$p; done   # 21 lines: inactive

# 2. Move the result OUT, with the companions it grew, together, to a place
#    whose names cannot collide with the original's in /data/replaced/.
cd /data/memory/engine-v3/engine-v3/
sudo mkdir -p /data/replaced/rolled-back
sudo mv '<did>.sqlite'* /data/replaced/rolled-back/

# 3. Move the original back with its companions. The glob matches the
#    original and its companions only: the backup, result and dry-run files
#    are named <did>.<what>.sqlite. Nothing of the result's is left beside it.
sudo mv /data/replaced/'<did>.sqlite'* .
ls -la '<did>.sqlite'*

# 4. Start them all, confirm, read back, as step 7 does. (sudo.)
for p in $(seq 8001 8021); do sudo systemctl start toolshed-binary@$p; done
for p in $(seq 8001 8021); do systemctl is-active toolshed-binary@$p; done
```

Before step 7 has run, step 1 already holds and the rest is the same.

## What the store shows afterward

`cf inspect commits` names the compaction run's own commit and every payload
it hollowed, in place of counting zero operations on them. The ACL document,
where the space has one, carries a `compaction` member beside `value` with
each run that completed and the newest seq any removed row had; `cf inspect`
labels the document with it. A run interrupted before its audit revision is
on record only in its compaction commit, whose payload is the plan it set out
with, and the run that resumed it reports what remained, so the commit list
and the ACL's `runs` reconcile only once the two are read together. The Topics space has no ACL document, so there the
compaction commit is the store's one record of the run, and the archive the
operator took is where the history before it lives.

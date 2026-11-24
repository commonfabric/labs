---
status: historical
created: 2026-10-18
archived: 2026-10-18
reason: "Production record of the pinned Topics board migration and stage-7 compaction on Estuary."
---

# Estuary Topics board migration and production compaction

The original [#8835](https://github.com/commonfabric/labs/pull/8835) board
update and stage 7 of [the compaction plan](../plans/compact-space.md) completed
on October 18. Wilk performed the privileged stop, installation, and restart;
Astra prepared and verified the migration, snapshots, compaction, and readback.
Wilk confirmed Gideon's approval of the compaction and its history loss.

## Deployment inputs

- Engine and migration CLI: `1f79253c30730035bfbb89d03b2f7b0af593861e`,
  verified on all 21 workers against its successful main-push build and
  artifact attestations.
- Board source checkout: `75711b5c45a6ed6deb48a4b8d48192d8f500de80`.
- Board pattern: `t6M4hXh4woOXzcF8S4SAcTqRTYIRoNHKd5R3j-BnEis`.
- Compaction CLI: `aa1f966bd09666afab7d47216ec5be6093bab6db`
  ([#9045](https://github.com/commonfabric/labs/pull/9045)); binary SHA-256
  `2374389fd9a1150a8622cfd5031792f2c623d61b65ae6ffcd479a6359db7290d`.
  Its successful main-push build was
  [39104377795](https://github.com/commonfabric/labs/actions/runs/39104377795).
- Infrastructure manifest: `scripts/migrations/estuary-maintenance-2026-10-18.json`
  at infra `7cf170139356fa8ea0428ffa11afc840175bd3db`, including
  [#409](https://github.com/commonfabric/infra/pull/409),
  [#415](https://github.com/commonfabric/infra/pull/415), and
  [#416](https://github.com/commonfabric/infra/pull/416). References were
  checked against GitHub main from clean checkouts before deployment.
- Selection: `--documents computed: --keep-payloads 7d`, with full verification
  before installation and no sampling flag.

The host had already been upgraded to `n4d-standard-16` (16 vCPUs, 64 GiB)
and a 1,024 GiB Hyperdisk Balanced data disk at 20,000 IOPS / 800 MiB/s.

## Board migration

Wilk accepted the two completed October 17 rehearsals plus one complete
October 18 current-server pass as repeatability evidence. The earlier passes
used the previous server release and 1,111 topics; the current-server pass
used 1,138 topics. The current pass included exhaustive verification,
authored-content comparison, browser navigation, rollback, and settled writes.

The exhaustive comparison found 18 changed free cells. Investigation showed
that all were UI vnode schema references rewritten during baseline navigation,
before the board apply. Expanding their content-addressed schemas, including
nested definitions, proved equivalent values and no other document changes.
All authored records were identical; no entities were removed and none were
ambiguous or unhashable. An interrupted driver stopped its local server;
rollback resumed against the same durable clone after a source survey.

Production apply completed at 08:29:16 UTC, with a complete one-row receipt:
127.072 seconds in the receipt, 143.344 seconds for the command. The survey
converged. Every authored record at pre-apply production sequence 2569066
matched the post-board snapshot: 1,140 topics, 3,615 comments, and 1,575 links.
This exact-sequence comparison accounted for a live title edit during snapshot
transfer. The index preserved identities, titles, numbers, and displayed counts.

The browser rendered all 1,140 cards and navigated to Topic 1014 with no page
errors. After the apply spike, observed writes were at most four commits per
minute from 08:33 through 09:00 UTC. The single production browser observation
reached board-ready at 40.165 seconds; it was an acceptance observation without
a controlled production baseline.

## Compaction and exhaustive verification

The fresh post-board rehearsal used the same immutable CLI and flags as the
host run. It reduced 27,900,280,832 bytes to 12,905,611,264 bytes. Compaction
took 9m39s and all 24 verification checks passed in 38m07s. A separate exact
copy of the result passed browser navigation, a served title edit and restore,
durable authored-content comparisons, and a two-minute zero-write observation.
A capture-helper path error was corrected before the durable edit/restore
checks completed; the fully verified result itself was never served or changed.

After nginx and all workers stopped, the authoritative backup was captured at
sequence 2571656. The host compacted a separate copy of that backup.

| Host operation | Result |
| --- | --- |
| Authoritative backup | 27,955,134,464 bytes; 3m57s |
| Compaction | 12,960,301,056 bytes; 13m03s |
| Full verification | 24 checks passed; 34m22s |
| Size reduction | 14,994,833,408 bytes, about 54% |

All 1,435,361 document instances compared identically. All 262,074
materialized boundaries matched their original exact-row states; 2,101,171
revision rows and 1,620 snapshots were removed according to the plan. All
2,487,796 hollowed payload markers were checked against the backup. Every
commit row survived, all 11 non-history tables matched, and both content
fingerprints were `fid1:AMTcU2IS06bM-K9BCcgLs4HMhy7WW9_0_1YJKl89Uq0`.

- Authoritative backup SHA-256:
  `6fcd500e2a626f2d1badeb943b8f2bbf2936c11c53fcfd6d66217dd5592631c0`.
- Verified result SHA-256:
  `9cd14094f89a9104dc15c2396d20813ccecd3dcde5c8dadcca2bd30922ebf018`.

## Installation, acceptance, and retention

The operator archived the original database with its companions, installed the
verified result as `deploy:deploy` with mode `0600`, checked its checksum, and
started all 21 workers while nginx remained stopped. Private API/browser
acceptance preserved all 1,140 topic references, rendered every card, navigated
to Topic 1014, and reported no browser errors. The board input and full inputs
of Topics 1014, 1027, and 1131 matched the authoritative backup before and after
acceptance. Their full bodies were also read through the API.

Services stopped at 10:12:03–05 UTC. Full verification finished at 11:08:45 UTC,
and final checksum checks finished at 11:09:08 UTC. Nginx reopened at
12:37:17 UTC after the operator installation/start handoff and acceptance.
Public metadata and board HTML returned HTTP 200; public Topic 1014 title and
full-body readback matched the authoritative backup.

Host evidence and retained databases are under
`/data/replaced/estuary-20261017/maintenance-20261018/`, with reports in
`host-compaction/`, the original in `original/`, and the authoritative backup,
working copy, and verified result alongside them. Local evidence is under
`/home/wkelly/clones/estuary-maintenance-20261018/`; the main report directories
are `production-board-current`, `compaction-served`, `host-compaction`, and
`host-installed-acceptance` beneath `reports/`.

All databases, companions, rehearsal archives, and the named pre-maintenance
GCP snapshots were retained pending explicit authorization to delete them.
Any rollback after service resumed requires preserving and reconciling new
writes before restoring an older database. The separate stage-8 engine work
remained outside this maintenance.

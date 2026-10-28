# Deploying a release

Server deployments run through the bastion using binaries that CI has built
and published. Rapids releases coordinate Labs, Loom, Weaver, gVisor, and infra
at verified green `main` revisions. Estuary takes a manually selected Labs
revision from `main` or the time-limited `alex-daily` demo branch.

Two browser shells reach users, and they are configured in different places.
The toolshed binary carries one and serves it from its own origin, so it is
configured when that binary is built; "The shell inside the binary" below
covers it. The other is a static site published to its own bucket, and "The
staging shell" covers that one.

The server deployment entrypoints are:

| Job | Workflow | Bastion command | Trigger |
| --- | --- | --- | --- |
| `deploy` | `.github/workflows/rapids-release.yml` | `/opt/cf/deploy-rapids.sh "$INFRA_SHA"` | infra dispatch on Labs `main`, naming the candidate's infra commit |
| `deploy-estuary` | `.github/workflows/deploy-production.yml` | `/opt/cf/deploy.sh <environment> <Labs SHA>` | manual dispatch on `main`, naming a full SHA and source branch |

The production job reads the environment name from a repository variable rather
than naming it, because the variable is defined on the GitHub environment the
job declares.

The Rapids job declares GitHub's `toolshed` environment, which holds
`BASTION_HOST` and `BASTION_SSH_PRIVATE_KEY`. It connects as `bastion`. The
production job downloads the selected commit's artifacts itself and fails with
a message naming that commit if they are absent.

## Estuary demo deployment and verification

**Manual Production Deployment** (`deploy-production.yml`) runs from `main`
and takes these inputs:

- `ref`: the full lowercase Labs commit SHA to deploy or verify.
- `source_branch`: `main` (default) or `alex-daily`. The selected SHA must be
  an ancestor of this branch, verified through GitHub before the protected job
  can start.
- `verify_only`: `false` (default) deploys through the existing bastion wrapper;
  `true` checks the running backend without deploying or downloading artifacts.

`alex-daily` is authorized from `2026-10-19T22:15:16Z` inclusive until
`2026-10-22T22:15:16Z` exclusive. The workflow checks the window before requesting
environment approval, after approval, and immediately before deployment.
Concurrent Estuary runs serialize without cancelling an in-progress run.

The `estuary` environment retains its required reviewers. An hourly coordinator
must arrange approval by an existing required reviewer; dispatch alone does not
make a release active. A temporary reviewer credential used for automation must
be restricted by the coordinator to the exact selected run and authorization
window, and removed at expiry.

After deployment, or immediately in verification-only mode, the workflow uses
the existing bastion connection to read `/api/meta` from all 21 Estuary workers
on ports 8001–8021 and from `https://estuary.saga-castor.ts.net/api/meta`. Every
response must be HTTP 200 at the requested URL and report the selected SHA.
The verification makes one request per endpoint and fails on an unavailable or
mismatched endpoint.

Successful verification uploads `receipt.json` in the GitHub artifact
`estuary-deployment-<run_id>-<run_attempt>`. It records `repository`,
`workflow_sha`, `run_id`, `run_attempt`, `source_branch`, `verify_only`,
`labs_sha`, `verified_at`, `expected_workers`, `workers`, and `https`.
Each worker has `host`, `port`, and `git_sha`; `https` has `url` and `git_sha`.
The receipt is uploaded only after the complete worker set and HTTPS result
have been validated. The coordinator must verify the successful workflow
identity, run attempt, artifact digest, selected SHA, and receipt freshness
before advancing the Estuary channel in infra.

Production deployment and verification-only completions wake infra's
`rapids.yml` on `main` with `channel=estuary` while the authorization window is
open. `.github/workflows/notify-rapids.yml` selects the production workflow by
its path, main branch, repository, and dispatch event. It uses the existing
infra-only App token. Every completion is a reconciliation hint, including a
failed or cancelled run; the coordinator still validates the selected source,
successful run, and receipt before publishing.

## Coordinated Rapids releases

Labs CI publishes binaries and attestations on green pushes to `main`.
`.github/workflows/notify-rapids.yml` then dispatches two workflows with the
paired `producer=commonfabric/labs` and `run_id` hints:

- `commonfabric/infra`: `rapids.yml`, which reconciles the release candidate.
- `commonfabric/loom`: `rapids-dependencies.yml`, which integrates verified
  producer dependencies and resolves their revisions independently.

Each notification uses a separate repository-scoped Actions-write token from
`RAPIDS_APP_ID` and `RAPIDS_APP_PRIVATE_KEY`. Notifications follow successful
main-push CI runs in this repository. They execute no checked-out code.

The infra coordinator selects the latest green main revisions and verifies
their immutable artifacts. It lands `releases/rapids-candidate.json` on infra
`main` and keeps that candidate frozen through deployment and publication. See
[infra's Rapids release documentation](https://github.com/commonfabric/infra/blob/main/releases/rapids.md)
for selection and reconciliation rules.

The coordinator dispatches `rapids-release.yml` on Labs `main` with the single
required string input `infra_sha`. The run is named `Deploy Rapids <infra_sha>`.
The `rapids-release-deploy` concurrency group serializes runs without canceling
an in-progress deployment. The job has a 60-minute total limit covering setup,
validation, deployment, and receipt upload. Within that budget, the remote
command has a 45-minute limit. The receiver performs these steps in order:

1. Require a 40-character lowercase hexadecimal SHA and ask GitHub whether it
   is an ancestor of infra `main`, before checking out or executing infra code.
2. Check out `commonfabric/infra` at that exact SHA, with full history and no
   persisted credentials. Install `jsonschema[format]==4.23.0` for validation.
   Exchange the job's GitHub OIDC identity for a short-lived, read-only Google
   access token using `RAPIDS_ARTIFACT_WORKLOAD_IDENTITY_PROVIDER` and
   `RAPIDS_ARTIFACT_SERVICE_ACCOUNT`. Infra manages those repository variables
   and the main-workflow trust in `tofu/weaver-dev-builds`.
3. Run `releases/rapids_deploy.py <infra_sha> --validate-only`. The infra
   validator requires a clean exact checkout, main ancestry, a candidate equal
   to the current main candidate, green infra checks, green producer pins, and
   the exact Labs archive and attestation. The candidate file supplies artifact
   selections. `RAPIDS_ARTIFACT_ACCESS_TOKEN` lets this step read the selected
   Weaver completion manifest through the authenticated GCS API. The validator
   verifies its pinned checksum against the downloaded bytes. The token is
   scoped to manifest reads and is passed only to this validation step.
4. Call `/opt/cf/deploy-rapids.sh "$INFRA_SHA"` on the bastion. The wrapper
   locks deployments, verifies the infra checkout and producer main ancestry,
   and invokes infra's `rapids_release.yml` playbook. Deployment is forward-only;
   completion requires all 21 workers to report the expected SHAs.
5. Pass the captured `RAPIDS_RECEIPT:<base64-json>` output to
   `releases/rapids_deploy.py <infra_sha> --save-receipt <path>`. The validator
   binds the receipt to the candidate, the Labs workflow SHA, run and attempt,
   and the expected worker set and SHAs. The captured stream includes remote
   stderr and the SSH action's success banner; the parser requires exactly one
   receipt marker line.
6. Upload only the verified receipt as
   `rapids-deployment-<run_id>-<run_attempt>`, retained for 90 days. A failed
   validation or deployment stops this sequence before proof is uploaded.

The evidence token is read-only for contents and Actions in `infra`, `loom`,
`labs`, `commonfabric-weaver`, and `gvisor`. The bastion receives that token,
`INFRA_SHA`, and the Labs orchestrator's `GITHUB_SHA`, `GITHUB_REPOSITORY`,
`GITHUB_RUN_ID`, and `GITHUB_RUN_ATTEMPT`.

Every completed `Deploy Rapids release` run on main, including failures and
cancellations, notifies infra with empty dispatch inputs. The coordinator
checks the trusted main workflow, run and attempt, GitHub artifact digest,
candidate hash, and every worker before proposing an update to the active
`releases/rapids.json`. That active file advances only after all-worker success.

## One commit, one set of artifacts

The `build-toolshed` and `build-cf` jobs in `.github/workflows/deno.yml` build
the binaries. Once every lane of the full run has passed, the `attest-binaries`
job signs them, packs them into `labs-<commit>.tar.gz`, writes that
tarball's SHA-256 into `labs-<commit>.hash.txt`, and copies both objects into
the `commontools-build-artifacts` bucket. A host downloads the pair, checks the
tarball against the checksum, and unpacks it. The Rapids candidate additionally
binds the exact archive and producer evidence verified by the coordinator.

Building one commit twice does not produce the same tarball. The binaries are
compiled again, and `tar` records the modification time of every file it packs.
The two objects therefore have to be published together, and what they were
published as has to stay put. A host holding one build's tarball beside another
build's checksum fails `sha256sum -c`, and its deploy stops there.

Two things keep a commit to one pair. The workflow's concurrency group keys a
push by the commit that was pushed, so a second run of a commit waits for the
first to finish instead of building alongside it. Main does receive the same
head commit twice from time to time, which is what starts two runs of one
commit. The second guard is in the publish step: a commit that already has both
objects in the bucket keeps them, so a later build of that commit leaves alone
what an earlier build published and a host may already be holding. That covers
the ways a second build starts without a second run, a re-run of the job among
them. Removing either object from the bucket by hand lets the next build of
that commit publish both of them again.

## Production artifact caching

The production deploy playbook downloads the tarball and the checksum only when
the release directory for the commit is missing a binary, and Ansible's `get_url`
leaves a destination file that is already there as it is. So a release
directory that failed verification stays as it is across later deploys of that
commit. The download tasks report no change, the same mismatched pair is
checked again, and the deploy fails the same way. A re-run cannot recover on
its own; someone has to remove the directory on the host.

That playbook is `ansible/playbooks/toolshed_binary_deploy.yml` in the
[infra repository](https://github.com/commonfabric/infra), behind the
`/opt/cf/deploy.sh` wrapper described above. Making the download replace what
it finds, rather than skip it, is a change in that repository.

## A deploy states when it happened

A toolshed orders the releases of the system patterns it serves by
`TOOLSHED_RELEASED_AT` ([configuration](CONFIGURATION.md#build-info)). Its
patterns route sends that time beside every identity it advertises, and a piece
that adopted one release is not moved to an earlier one. The value describes
the deploy rather than the commit, so it is the time a deploy happens, and every
deploy sets it again — a deploy of a commit already deployed included, since
rolling a bad release back that way makes it the latest release there is.

Every instance a deploy restarts has to read the same value, and to read it
alongside the binary it starts. A host restarts its instances one after another,
so for a while some serve the release being replaced and some the one replacing
it; the time is what tells a piece which of the two to keep. A value kept with
the release the instances run from gives that pairing by construction. A
toolshed whose environment does not set the time advertises identities alone.
A piece it serves then follows whichever identity it was offered last, unless
the source the piece runs carries a time from another release, adopted or
confirmed: an offer with no time is earlier than that one, and the piece keeps
its source unless it has nothing it can start. Without times, a host partway through a deploy and a deliberate
rollback offer a piece the same earlier identity, so a piece cannot be kept
from moving back and forth between the two releases until every instance runs
one of them.

The time has to be the deploy's own. A time from the future would stamp every
release a piece adopts from that deploy, and every correct release after it
would read as earlier, so pieces would stay where they are until a deploy stated
a later time still. A toolshed therefore refuses to start with a time more than
five minutes ahead of its own clock, which allows for skew between the host that
deploys and the hosts that run.

## The wrappers are owned by infra

The [infra repository](https://github.com/commonfabric/infra) generates
`/opt/cf/deploy.sh` and `/opt/cf/deploy-rapids.sh` in
`ansible/playbooks/bastion.yml` and installs them on the bastion. Their
implementations and deployment validation tests belong there; Labs checks its
call sites against their interfaces.

The production wrapper takes exactly two arguments: an
environment name it recognizes, and a 40-character commit SHA. Given anything
else — an extra argument, an unknown environment, a revision that is not a
full SHA — it prints its usage and exits with status 1, and the deploy job
fails without deploying anything.

The Rapids wrapper takes one full infra SHA. Its GitHub environment variables
identify the Labs orchestrator run, while its candidate identifies the producer
commits to deploy. [`tasks/rapids-workflows.test.ts`](../../tasks/rapids-workflows.test.ts)
checks this interface, the trust gates and receipt upload ordering. The
production interface is checked in
[`tasks/ci-workflow.test.ts`](../../tasks/ci-workflow.test.ts).

Changes to these interfaces land in order: land the infra implementation,
apply the bastion playbook so the host has that implementation, then merge the
Labs call sites. Installing the Rapids wrapper uses the `rapids-deploy-script`
tag. The deployment transition also blocks the independent `deploy.sh rapids`
entrypoint so queued CI runs cannot race the coordinated release.

## The shell inside the binary

`toolshed` serves a browser shell from the `shell-frontend` directory beside
it, so <https://estuary.saga-castor.ts.net/> and
<https://rapids.saga-castor.ts.net/> each serve the shell that the binary they
run was built with. `tasks/build-binaries.ts` builds `packages/shell` as part
of the toolshed build and moves the output there. Configuring this shell is
therefore something the `build-toolshed` job does, and a deploy carries
whatever that build baked in. It needs no API host: it is served from the same
origin as the API it calls, which is what the shell falls back to.

## The staging shell

The `deploy-shell-staging` job in `.github/workflows/deno.yml` publishes the
shell on every push to `main`. It does not touch the bastion: it builds
`packages/shell` and copies the result into the `staging-commontools-dev`
bucket, which is served at <https://staging.commontools.dev/>. Each build also
lands under `builds/<commit>/` so a page that is already open keeps the exact
module graph it started with.

The shell has to be told which API host to talk to, because it is served from a
different origin than the API it calls. The `STAGING_SHELL_API_URL` variable
carries that host, and the build substitutes it into the bundle. It is a
variable rather than a secret: the value ends up in a bundle that anyone can
read, so hiding it from review buys nothing and costs the ability to see what
staging points at. The host it names is the server the coordinated Rapids
release keeps current. This static shell follows Labs main separately; the
same-origin shell inside the Rapids toolshed binary follows the candidate.

Publishing is not the same as working, and this job cannot tell the difference
by uploading alone — it makes no request to the API it just configured. So it
checks three things instead. An unset variable fails the job before the build,
because a shell built with no API host falls back to its own origin, and that
origin serves static assets and no API. The built bundle must then contain the
host that was passed in. Finally the scripts are read back out of the bucket
and checked again, so a green job means the objects being served name the host
they should. That last read goes to the bucket rather than to the site's
address, because the CDN may still be serving the previous build.

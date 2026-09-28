# Deploying a commit

A commit reaches a server host by way of the bastion. The deploy jobs in CI
open an SSH connection to the bastion and run one command there,
`/opt/cf/deploy.sh`, passing the environment to deploy and the commit to deploy
to it. That script does the rest: it deploys the binaries that CI already built
and uploaded for that commit.

Two browser shells reach users, and they are configured in different places.
The toolshed binary carries one and serves it from its own origin, so it is
configured when that binary is built; "The shell inside the binary" below
covers it. The other is a static site published to its own bucket, and "The
staging shell" covers that one.

Two jobs do this:

| Job | Workflow | Environment passed | Trigger |
| --- | --- | --- | --- |
| `deploy-rapids` | `.github/workflows/deno.yml` | `rapids`, written out in the step | every push to `main` |
| `deploy-estuary` | `.github/workflows/deploy-production.yml` | `DEPLOYMENT_ENVIRONMENT` variable | manual dispatch, naming the ref to deploy |

The production job reads the environment name from a repository variable rather
than naming it, because the variable is defined on the GitHub environment the
job declares.

The staging job waits on `attest-binaries`, because the script deploys binaries
rather than building them. There is nothing for it to deploy until that job has
uploaded the artifacts for the commit. The production job downloads those same
artifacts itself, and fails with a message naming the commit if they are not
there.

Staging used to deploy to toolshed as well, from a `deploy-toolshed` job in
`.github/workflows/deno.yml`. Toolshed has been decommissioned and rapids
replaces it, so that job is gone and `deploy-rapids` is the only staging
deploy. The `deploy-rapids` job still declares GitHub's `toolshed` environment,
which is where its bastion credentials live; renaming that environment is a
repository-settings change, and the job has to be updated in the same change.

## One commit, one set of artifacts

The `build-toolshed` and `build-cf` jobs in `.github/workflows/deno.yml` build
the binaries. Once every lane of the full run has passed, the `attest-binaries`
job signs them, packs them into `labs-<commit>.tar.gz`, writes that
tarball's SHA-256 into `labs-<commit>.hash.txt`, and copies both objects into
the `commontools-build-artifacts` bucket. A deploy is given a commit rather than
a build, so those two objects are the whole of what a commit means to a host.
The host downloads them, checks the tarball against the checksum, and unpacks
it.

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

## A host keeps what it has already downloaded

The deploy playbook downloads the tarball and the checksum only when the
release directory for the commit is missing a binary, and Ansible's `get_url`
leaves a destination file that is already there as it is. So a release
directory that failed verification stays as it is across later deploys of that
commit. The download tasks report no change, the same mismatched pair is
checked again, and the deploy fails the same way. A re-run cannot recover on
its own; someone has to remove the directory on the host.

That playbook is `ansible/playbooks/toolshed_binary_deploy.yml` in the
[infra repository](https://github.com/commonfabric/infra), behind the
`/opt/cf/deploy.sh` wrapper described above. Making the download replace what
it finds, rather than skip it, is a change in that repository.

## The wrapper is owned by another repository

`/opt/cf/deploy.sh` is not in this repository. The
[infra repository](https://github.com/commonfabric/infra) generates it, in
`ansible/playbooks/bastion.yml`, and writes it to the bastion when that
playbook runs. Nothing here reads it, imports it, or tests it against the real
thing.

The script validates what it is given, and it takes exactly two arguments: an
environment name it recognizes, and a 40-character commit SHA. Given anything
else — an extra argument, an unknown environment, a revision that is not a
full SHA — it prints its usage and exits with status 1, and the deploy job
fails without deploying anything.

This is the seam to be careful about. The staging deploy jobs run only on
`main`, so a deploy step that no longer matches the script cannot fail on the
pull request that introduces it. It fails on the first push to `main`
afterwards, and then on every push after that until someone fixes it. The
`Deploy steps call the bastion wrapper the way it accepts` case in
[`tasks/ci-workflow.test.ts`](../../tasks/ci-workflow.test.ts) reads the
`script:` line out of each deploy step and checks it against that contract, so
a mismatch fails on the pull request instead.

Changing the argument list therefore takes a change in each repository, in
order: land the infra change, apply the bastion playbook so the host has the
new script, then change the call sites here.

## The shell inside the binary

`toolshed` serves a browser shell from the `shell-frontend` directory beside
it, so <https://estuary.saga-castor.ts.net/> and
<https://rapids.saga-castor.ts.net/> each serve the shell that the binary they
run was built with. `tasks/build-binaries.ts` builds `packages/shell` as part
of the toolshed build and moves the output there. Configuring this shell is
therefore something the `build-toolshed` job does, and a deploy carries
whatever that build baked in. It needs no API host: it is served from the same
origin as the API it calls, which is what the shell falls back to.

`SHELL_PRESENCE_URL`, a repository variable of this repository, optionally
names the WebSocket service used for ephemeral collaborative-editor presence.
Setting it is the whole of turning co-presence on for these two environments;
it is configuration rather than code, so it is set once and every later build
reads it. The job passes it to the build under the name the build reads,
`PRESENCE_URL`, and esbuild bakes it into the bundle as a define. A value that
is not a credential-free WebSocket URL is rejected by
`packages/shell/src/lib/presence-url.ts` and fails the build rather than
shipping, and the job confirms the URL reached the bundle before the binary is
uploaded. An unset variable omits the define, and a shell with no presence
endpoint is a working shell — unlike an absent API host, an absent presence
endpoint is not a misconfiguration, so nothing fails.

Because nothing fails either way, a green job does not by itself say which of
the two shells a binary carries. The build log does: the step names the
endpoint it passed to the build, or says the variable is unset and that
co-presence will be off wherever the binary runs.

Two consequences follow from the value being baked rather than read at start-up.
Changing the variable reaches a deployment only through a rebuild and a
redeploy, so a redeploy of an existing commit cannot change it. And one binary
serves both environments, so both carry the same endpoint — though not at the
same moment, because `deploy-rapids` ships every push to `main` on its own
while `deploy-estuary` waits to be dispatched. A variable change therefore
reaches rapids first and estuary when someone deploys it there.

What a running deployment actually carries is visible from outside it: the URL
is in the `/scripts/index.js` that deployment serves, or it is not.

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
staging points at. The host it names is the one `deploy-rapids` keeps current.

`STAGING_SHELL_PRESENCE_URL` optionally names the WebSocket service used for
ephemeral collaborative-editor presence. When it is unset, the shell provides
no default and co-presence stays disabled unless an editor supplies an explicit
endpoint. Like the API URL, a configured presence URL is public build
configuration, and the deployment job verifies it in both the built and
published scripts.

Publishing is not the same as working, and this job cannot tell the difference
by uploading alone — it makes no request to the API it just configured. So it
checks three things instead. An unset variable fails the job before the build,
because a shell built with no API host falls back to its own origin, and that
origin serves static assets and no API. The built bundle must then contain the
host that was passed in. Finally the scripts are read back out of the bucket
and checked again, so a green job means the objects being served name the host
they should. That last read goes to the bucket rather than to the site's
address, because the CDN may still be serving the previous build.

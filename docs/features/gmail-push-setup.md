# Gmail push setup

Everything [Gmail push ingest](gmail-push-ingest.md) needs that is not code in
this repository: the Google Cloud resources, the permissions on them, and the
settings on the toolshed deployment. [`gmail-push-architecture.md`](gmail-push-architecture.md)
says which party owns each piece; this document is the commands.

The commands use these placeholders:

| Placeholder | What it is |
| --- | --- |
| `<project>` | The Google Cloud project id. |
| `<topic>` | The Pub/Sub topic Gmail publishes to. |
| `<subscription>` | The subscription on that topic. |
| `<account>` | The service account's email, `<name>@<project>.iam.gserviceaccount.com`. |
| `<audience>` | The audience on push tokens: `<service space>`, unless the deployment sets `INGEST_GMAIL_PUSH_AUDIENCE` to something else. |
| `<toolshed>` | The toolshed deployment's origin. |
| `<client id>`, `<client secret>` | The OAuth client's two values, from its downloaded JSON. |
| `<space>` | The DID of the user's space that the channel writes into. |
| `<channel>` | The ingest channel's id, which `cf ingest mint` prints. |
| `<service space>` | The space the deployment keeps its ingest registry in: the DID `INGEST_SERVICE_SPACE` names, or with that unset, the DID of the deployment's own identity, which `GET <toolshed>/api/meta` reports as `did`. |

## Choosing the project

The topic has to be in the Google Cloud project that owns the OAuth client
users sign in to Gmail with. Gmail refuses a `users.watch` whose topic is in
any other project. So the project is decided by the OAuth client, not chosen
freely: use the client's project, or create the client in the project you
want.

`gcloud projects list` shows the projects the signed-in account can see.

## The `gcloud` CLI

On Debian or Ubuntu, including under WSL, install it from Google's apt
repository:

```bash
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update && sudo apt-get install -y google-cloud-cli
```

Sign in. Where there is no browser to open, as under WSL, this prints a link
to open elsewhere:

```bash
gcloud auth login --no-launch-browser
```

## Google Cloud resources

Enable the two APIs:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com --project <project>
```

Create the topic, and let Gmail publish to it. Gmail publishes as one fixed
Google-owned service account, and without this grant `users.watch` fails:

```bash
gcloud pubsub topics create <topic> --project <project>
gcloud pubsub topics add-iam-policy-binding <topic> --project <project> \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

That grant names a principal outside the project's organization. An
organization that restricts IAM members to its own domain refuses it, and
needs an exception for this one member. This shows whether the restriction
applies; `allValues: ALLOW` means it does not:

```bash
gcloud resource-manager org-policies describe iam.allowedPolicyMemberDomains \
  --project <project> --effective
```

Create the service account whose identity push deliveries carry. Toolshed
accepts a delivery only when its token is signed for an account listed in
`INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS`:

```bash
gcloud iam service-accounts create <name> --project <project> \
  --display-name="Gmail push delivery identity"
```

## The subscription

Which kind depends on whether Google can reach the deployment.

### A deployment Google can reach

A push subscription delivers straight to toolshed. The endpoint has to be
HTTPS with a certificate Google accepts:

```bash
gcloud pubsub subscriptions create <subscription> --project <project> \
  --topic <topic> \
  --push-endpoint="<toolshed>/api/spaces/<service space>/ingest-push/gmail" \
  --push-auth-service-account="<account>" \
  --push-auth-token-audience="<audience>" \
  --expiration-period=never
```

A subscription expires 31 days after its last subscriber activity unless
told otherwise, and an expired subscription is deleted. Successful pushes
count as activity, so a subscription that is delivering keeps itself alive;
one whose every watch has lapsed does not, and would have to be created
again. `--expiration-period=never` is what keeps it through a quiet month.

Pub/Sub mints each push token itself, as its own service agent,
`service-<project number>@gcp-sa-pubsub.iam.gserviceaccount.com`. A project
created after April 8, 2019 lets the agent do that with nothing further. An
older project needs the agent granted the Service Account Token Creator role,
without which every delivery fails to authenticate:

```bash
gcloud projects add-iam-policy-binding <project> \
  --member="serviceAccount:service-<project number>@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

A machine on a tailnet can be made reachable for this route with Tailscale
Funnel, which publishes the machine's HTTPS port at its `ts.net` name with a
certificate. The push endpoint is the route built to face the internet, since
it refuses anything without a token Google signed.

Funnel opens that whole port, not one path: every route mounted on it becomes
public, whether this command mounted it or an earlier `tailscale serve` did.
So the rest of the server stays private only while the push path is the sole
route on the port. Run `tailscale serve status` before and after, and expect
to see the push path and nothing else. A path with no route mounted returns
Tailscale's own 404 and never reaches the server.

The command mounts the push path alone. Its target repeats the path, because
Funnel strips the mounted prefix before forwarding:

```bash
tailscale funnel --bg \
  --set-path "/api/spaces/<service space>/ingest-push/gmail" \
  "http://localhost:8000/api/spaces/<service space>/ingest-push/gmail"
```

The public DNS record for a machine's first Funnel takes several minutes to
appear, and until it does Pub/Sub cannot deliver. `tailscale funnel reset`
takes it down. The subscription's audience is not the public URL: it is
`<audience>`, as for any deployment.

### A deployment on a private network

A deployment reachable only on a private network, a tailnet for instance,
cannot be a push endpoint: Google has no route to it. A pull subscription
works in its place, with a relay on the private network that pulls each
message and posts it to `<toolshed>/api/spaces/<service space>/ingest-push/gmail`
the way a push subscription would. The relay needs no certificate, since it
reaches toolshed from inside the network.

```bash
gcloud pubsub subscriptions create <subscription> --project <project> \
  --topic <topic> --ack-deadline=30 --message-retention-duration=1d \
  --expiration-period=never
```

Pulls count as subscriber activity the way pushes do, so the expiration
setting matters here for the same reason.

Whoever runs the relay needs two permissions. The first is to pull from the
subscription. A project owner has it already; anyone else needs the Pub/Sub
Subscriber role on the subscription:

```bash
gcloud pubsub subscriptions add-iam-policy-binding <subscription> --project <project> \
  --member="user:<you>" --role="roles/pubsub.subscriber"
```

The second is to sign each delivery with an identity token for the service
account. Owning the project does not include that permission; it is a
separate role, granted on the service account:

```bash
gcloud iam service-accounts add-iam-policy-binding <account> --project <project> \
  --member="user:<you>" --role="roles/iam.serviceAccountTokenCreator"
```

The grant takes around a minute to take effect, during which minting a token
still fails with `IAM_PERMISSION_DENIED`. This mints one, and succeeding is the
check that the grant has landed:

```bash
gcloud auth print-identity-token --impersonate-service-account=<account> \
  --audiences="<audience>" --include-email
```

The token's `aud` is `<audience>` and its `email` is `<account>`, which are the
two values toolshed compares against its settings.

### Several deployments

A mailbox can wake more than one deployment: a staging toolshed and a
production one, say, or two that a person runs a different weaver against.
The fan-out happens in Pub/Sub, which delivers every message on a topic to
every subscription on it, and nowhere in toolshed. One deployment never
forwards a push to another.

Each deployment gets a subscription of its own on the shared topic, created
with the commands above, addressed to that deployment's service space and
carrying that space's DID as the audience:

```bash
gcloud pubsub subscriptions create <subscription> --project <project> \
  --topic <topic> \
  --push-endpoint="<toolshed>/api/spaces/<service space>/ingest-push/gmail" \
  --push-auth-service-account="<account>" \
  --push-auth-token-audience="<service space>" \
  --expiration-period=never
```

The service account can be the same for every subscription. The audience is
what keeps the deployments apart: a token minted for one deployment's
subscription names that deployment's service space, and every other
deployment refuses it. A deployment Google cannot reach takes the pull
variant above instead, with a relay of its own.

Bindings do not cross deployments either. A binding lives in the registry of
the deployment that handled the mint, and a push is delivered against the
bindings of the deployment that received it. So the steps under
[Binding a mailbox](#binding-a-mailbox) run once per deployment, each against
that deployment: a space the user owns there, the WRITE grant for that
deployment's identity, and a mint carrying the mailbox proof. A syncer bound to one
toolshed does only its own; two syncers on one machine, each pointed at a
different toolshed, each bind the same mailbox on their own. A deployment
holding no binding for a mailbox acknowledges its notifications with
`delivered: 0`.

The watch is set once for the mailbox, whichever deployment or syncer sets
it, since it names the topic and not a receiver. Renewing it from more than
one place is harmless.

Only the push path has to face the internet. Mint is called by the syncer
on the user's machine, with the user's own signing key, so it needs only
the reach the syncer already has to its toolshed, a private network
included. Where a deployment sits behind something that admits
public traffic by path, the rule to open is `/api/spaces/*/ingest-push/*`
and nothing wider: the push route refuses everything without a token Google
signed, and the control plane and data plane gain nothing from being
reachable from outside.

## The OAuth client and a Gmail token

Binding a mailbox and setting a watch both need a Google access token for the
mailbox, issued through an OAuth client in `<project>`. A syncer brings its
own client and sign-in. For a test, make a client by hand in the Cloud
console, since `gcloud` has no command for either step. Both steps are on the
Google Auth Platform pages, which **APIs & Services → OAuth consent screen**
opens:

1. **Google Auth Platform → Audience:** set the user type to Internal. That
   limits sign-in to accounts in the project's organization and needs no
   verification by Google.
2. **Google Auth Platform → Clients → Create client:** choose Desktop app, and
   download its JSON. `installed.client_id` and `installed.client_secret` in
   that file are `<client id>` and `<client secret>`.

The scope needed is `https://www.googleapis.com/auth/gmail.readonly`, which
covers the profile lookup that an access-token proof makes and the
`users.watch` call. Adding `openid` makes the code exchange return an ID
token beside the access token, which can prove the mailbox instead.

A Desktop client signs in through a loopback redirect: Google sends the
browser back to a `localhost` address with a one-time code in the query
string. Open this in a browser, signed in as the mailbox's account:

```text
https://accounts.google.com/o/oauth2/auth?client_id=<client id>&redirect_uri=http://localhost:8765&response_type=code&scope=openid%20https://www.googleapis.com/auth/gmail.readonly&access_type=offline&prompt=consent
```

After consent the browser lands on an address beginning
`http://localhost:8765/?`, with a `code=<code>` parameter among the others in
its query string. Nothing has to be listening there: the page fails to load,
and the code is in the address bar. Exchange it within a few minutes:

```bash
curl -s https://oauth2.googleapis.com/token \
  -d code="<code>" -d client_id="<client id>" -d client_secret="<client secret>" \
  -d redirect_uri="http://localhost:8765" -d grant_type=authorization_code
```

The response holds an `access_token`, good for an hour, and a `refresh_token`
that mints further ones. Both are credentials for the mailbox: keep them out
of the repository and out of shell history. A command with a token typed into
it lands in that history, so read the access token into a variable without
echoing it, and let the commands below name the variable:

```bash
read -rs GMAIL_ACCESS_TOKEN
```

This confirms which mailbox a token reads, and is the same lookup toolshed
makes when binding:

```bash
curl -s -H "Authorization: Bearer $GMAIL_ACCESS_TOKEN" \
  https://gmail.googleapis.com/gmail/v1/users/me/profile
```

The exchange above carries the client secret and the code the same way. Read
those into variables too, or run it from a file kept outside the repository.

## Toolshed settings

Two environment variables on the deployment, and a third for ID-token
proofs, described in [`CONFIGURATION.md`](../development/CONFIGURATION.md):

| Variable | Value |
| --- | --- |
| `INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS` | `<account>` |
| `INGEST_SELF_SERVE_ENABLED` | `true`, which mounts the control plane that mint sits on |
| `INGEST_GMAIL_OAUTH_CLIENT_IDS` | `<client id>`, to accept an ID token from that client as the mailbox proof. Unset, only an access token proves a mailbox. |

The audience needs no setting: it defaults to `<service space>`. A deployment
that wants another sets `INGEST_GMAIL_PUSH_AUDIENCE`. The audience is compared
as a string and does not have to resolve.

For a hosted deployment these are set where that deployment's environment is
managed, which is outside this repository. A request to
`POST /api/ingest-channels/list` that returns 404 means
`INGEST_SELF_SERVE_ENABLED` is off; 401 means it is on and the request was
unsigned.

## Binding a mailbox

With the deployment configured, the remaining steps act as the user, through
`cf` with `CF_API_URL` set to `<toolshed>` and `CF_IDENTITY` to the user's
keyfile.

Create a space the user owns, or use one they already own:

```bash
cf space create --label "gmail push"
```

The deployment writes each record into that space under its own identity, so
that identity needs WRITE there. Where the user's identity and the
deployment's are the same, as with a local server run under the default
development identity, there is nothing to grant. Otherwise grant it, naming
the `did` that `GET <toolshed>/api/meta` reports. Without the grant, minting
is refused, with an error that names the same DID and says to grant it WRITE:

```bash
cf acl set <deployment did> WRITE --space <space>
```

Mint a gmail channel into the space, naming the cell the notifications are
written to and carrying the Gmail access token as proof of the mailbox; the
mint binds the channel to it. `<target>` is a cell reference in `<space>`,
such as `/of:fid1:…/inbox`; a document id that nothing else in the space
uses is the caller's to choose. The command reads the token from
`CF_GMAIL_ACCESS_TOKEN`:

```bash
CF_GMAIL_ACCESS_TOKEN="$GMAIL_ACCESS_TOKEN" cf ingest mint --space <space> --install-id <install id> --target <target>
```

It prints the mailbox it bound, which is the one Gmail reports for the
token, and the target as a reference the command reads back. `<install id>`
names the subscription within the space, one per mailbox, and the same id
mints the same channel again on a retry or renewal; a second mailbox gets a
second install id and, unless their notifications are meant to share a
cell, a second target:

```bash
CF_GMAIL_ACCESS_TOKEN="$PERSONAL_TOKEN" cf ingest mint --space <space> --install-id gmail-personal --target /of:fid1:…personal
CF_GMAIL_ACCESS_TOKEN="$WORK_TOKEN" cf ingest mint --space <space> --install-id gmail-work --target /of:fid1:…work
``` A consent that returned a Google ID token can pass that instead, as
`CF_GMAIL_ID_TOKEN`, on a deployment whose `INGEST_GMAIL_OAUTH_CLIENT_IDS`
names the consent's client.

## Setting the watch

`users.watch` tells Gmail to publish to the topic when the mailbox changes.
Limiting it to the inbox leaves out label and read-state changes elsewhere:

```bash
curl -s -X POST https://gmail.googleapis.com/gmail/v1/users/me/watch \
  -H "Authorization: Bearer $GMAIL_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"topicName":"projects/<project>/topics/<topic>","labelIds":["INBOX"],"labelFilterBehavior":"include"}'
```

The response gives the mailbox's current `historyId` and an `expiration` in
milliseconds, seven days out. Repeat the call before then to keep the watch;
Google recommends daily. Gmail publishes one notification when a watch is
first set, carrying that same history id, so the path can be checked before
any mail arrives. Repeating the call on a mailbox that has not changed
publishes nothing.

To test delivery without waiting for mail, publish a message in Gmail's shape
to the topic. The history id is a quoted string: it is an unsigned 64-bit
integer, and toolshed drops a notification whose id arrives as a number too
large to be exact:

```bash
gcloud pubsub topics publish <topic> --project <project> \
  --message='{"emailAddress":"<address>","historyId":"<history id>"}'
```

`POST https://gmail.googleapis.com/gmail/v1/users/me/stop`, with the same
token and no body, ends the watch.

## What a relay does

For a deployment behind a pull subscription, the relay repeats three calls.
`<gcloud token>` is `gcloud auth print-access-token`, and `<identity token>`
is the token minted under "A deployment on a private network".

Pull waiting messages. The call holds open until one arrives:

```bash
curl -s -X POST -H "Authorization: Bearer <gcloud token>" -H "Content-Type: application/json" \
  -d '{"maxMessages":10}' \
  "https://pubsub.googleapis.com/v1/projects/<project>/subscriptions/<subscription>:pull"
```

Post each `receivedMessages[].message` to toolshed, wrapped the way a push
subscription wraps it:

```bash
curl -s -X POST -H "Authorization: Bearer <identity token>" -H "Content-Type: application/json" \
  -d '{"message": <message>, "subscription": "projects/<project>/subscriptions/<subscription>"}' \
  "<toolshed>/api/spaces/<service space>/ingest-push/gmail"
```

On a `2xx`, acknowledge the message with its `ackId`. On anything else, leave
it: Pub/Sub delivers it again once the acknowledgment deadline passes.

```bash
curl -s -X POST -H "Authorization: Bearer <gcloud token>" -H "Content-Type: application/json" \
  -d '{"ackIds":["<ack id>"]}' \
  "https://pubsub.googleapis.com/v1/projects/<project>/subscriptions/<subscription>:acknowledge"
```

## Checking it works

- Toolshed's response to a delivery is `{"delivered": 1}` for a bound mailbox
  with one live channel, and `{"delivered": 0}` for a mailbox nobody bound.
- `cf ingest ls` shows the channel's LAST SEEN time moving with each delivery.
- The notification lands in the cell `<target>` names in `<space>`,
  replacing the one before it.
- The history id in the cell is enough to fetch what changed. This lists what
  arrived in the inbox since an earlier id:

```bash
curl -s -H "Authorization: Bearer $GMAIL_ACCESS_TOKEN" \
  "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=<earlier id>&historyTypes=messageAdded&labelId=INBOX"
```

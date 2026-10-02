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
| `<audience>` | The audience on push tokens. By convention, the push endpoint's URL. |
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
  --push-auth-token-audience="<audience>"
```

### A deployment on a private network

A deployment reachable only on a private network, a tailnet for instance,
cannot be a push endpoint: Google has no route to it. A pull subscription
works in its place, with a relay on the private network that pulls each
message and posts it to `<toolshed>/api/spaces/<service space>/ingest-push/gmail`
the way a push subscription would. The relay needs no certificate, since it
reaches toolshed from inside the network.

```bash
gcloud pubsub subscriptions create <subscription> --project <project> \
  --topic <topic> --ack-deadline=30 --message-retention-duration=1d
```

The relay signs each delivery with an identity token for the service account,
so whoever runs it needs permission to mint one. Owning the project does not
include that permission; it is a separate role, granted on the service account:

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

The one scope needed is `https://www.googleapis.com/auth/gmail.readonly`. It
covers the profile lookup that binding makes and the `users.watch` call.

A Desktop client signs in through a loopback redirect: Google sends the
browser back to a `localhost` address with a one-time code in the query
string. Open this in a browser, signed in as the mailbox's account:

```text
https://accounts.google.com/o/oauth2/auth?client_id=<client id>&redirect_uri=http://localhost:8765&response_type=code&scope=https://www.googleapis.com/auth/gmail.readonly&access_type=offline&prompt=consent
```

After consent the browser lands on `http://localhost:8765/?code=<code>&…`.
Nothing has to be listening there: the page fails to load, and the code is in
the address bar. Exchange it within a few minutes:

```bash
curl -s https://oauth2.googleapis.com/token \
  -d code="<code>" -d client_id="<client id>" -d client_secret="<client secret>" \
  -d redirect_uri="http://localhost:8765" -d grant_type=authorization_code
```

The response holds an `access_token`, good for an hour, and a `refresh_token`
that mints further ones. Both are credentials for the mailbox: keep them out
of the repository and out of shell history. This confirms which mailbox a
token reads, and is the same lookup toolshed makes when binding:

```bash
curl -s -H "Authorization: Bearer <access token>" \
  https://gmail.googleapis.com/gmail/v1/users/me/profile
```

## Toolshed settings

Three environment variables on the deployment, described in
[`CONFIGURATION.md`](../development/CONFIGURATION.md):

| Variable | Value |
| --- | --- |
| `INGEST_GMAIL_PUSH_AUDIENCE` | `<audience>` |
| `INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS` | `<account>` |
| `INGEST_SELF_SERVE_ENABLED` | `true`, which mounts the control plane that binding sits on |

The audience is compared as a string. It does not have to resolve, and for a
deployment behind a relay it need not be a URL the relay can reach.

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
the `did` that `GET <toolshed>/api/meta` reports; without the grant, minting
returns 409:

```bash
cf acl set <deployment did> WRITE --space <space>
```

Mint a channel into the space, then bind it to the mailbox. The command reads
the Gmail access token from `CF_GMAIL_ACCESS_TOKEN`:

```bash
cf ingest mint --space <space> --install-id <install id> --cause-prefix gmail-push
CF_GMAIL_ACCESS_TOKEN="<access token>" cf ingest gmail-bind <channel>
```

`gmail-bind` prints the address it bound, which is the one Gmail reports for
the token.

## Setting the watch

`users.watch` tells Gmail to publish to the topic when the mailbox changes.
Limiting it to the inbox leaves out label and read-state changes elsewhere:

```bash
curl -s -X POST https://gmail.googleapis.com/gmail/v1/users/me/watch \
  -H "Authorization: Bearer <access token>" -H "Content-Type: application/json" \
  -d '{"topicName":"projects/<project>/topics/<topic>","labelIds":["INBOX"],"labelFilterBehavior":"include"}'
```

The response gives the mailbox's current `historyId` and an `expiration` in
milliseconds, seven days out. Repeat the call before then to keep the watch;
Google recommends daily. Gmail publishes one notification as soon as a watch
is set, carrying that same history id, so the path can be checked before any
mail arrives.

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
- The record lands in the journal cell `gmail-push/<UTC day>` in `<space>`,
  where `gmail-push` is the channel's cause prefix.
- The history id in a record is enough to fetch what changed. This lists what
  arrived in the inbox since an earlier id:

```bash
curl -s -H "Authorization: Bearer <access token>" \
  "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=<earlier id>&historyTypes=messageAdded&labelId=INBOX"
```

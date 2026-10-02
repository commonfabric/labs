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
  --push-endpoint="<toolshed>/api/ingest-push/gmail" \
  --push-auth-service-account="<account>" \
  --push-auth-token-audience="<audience>"
```

### A deployment on a private network

A deployment reachable only on a private network, a tailnet for instance,
cannot be a push endpoint: Google has no route to it. A pull subscription
works in its place, with a relay on the private network that pulls each
message and posts it to toolshed the way a push subscription would. The relay
needs no certificate, since it reaches toolshed from inside the network.

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

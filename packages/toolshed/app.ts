import createApp from "@/lib/create-app.ts";
import health from "@/routes/health/health.index.ts";
import telemetry from "@/routes/telemetry/telemetry.index.ts";
import aiLLM from "@/routes/ai/llm/llm.index.ts";
import configureOpenAPI from "@/lib/configure-open-api.ts";
import aiImg from "@/routes/ai/img/img.index.ts";
import aiVoice from "@/routes/ai/voice/voice.index.ts";
import linkPreview from "@/routes/link-preview/link-preview.index.ts";
import agentToolsWebSearch from "@/routes/agent-tools/web-search/web-search.index.ts";
import agentToolsWebRead from "@/routes/agent-tools/web-read/web-read.index.ts";
import plaidOAuth from "@/routes/integrations/plaid-oauth/plaid-oauth.index.ts";
import { buildProviderRouters } from "@/routes/integrations/provider-registry.ts";
import memory from "@/routes/storage/memory/memory.index.ts";
import memoryDump from "@/routes/storage/memory/memory-dump.index.ts";
import blobs from "@/routes/blobs/blobs.index.ts";
import whoami from "@/routes/whoami/whoami.index.ts";
import meta from "@/routes/meta/meta.index.ts";
import shell from "@/routes/shell/shell.index.ts";
import staticRoute from "@/routes/static/static.index.ts";
import patterns from "@/routes/patterns/patterns.index.ts";
import sandboxExec from "@/routes/sandbox/exec/exec.index.ts";
import webhooks from "@/routes/webhooks/webhooks.index.ts";
import ingest from "@/routes/ingest/ingest.index.ts";
import ingestChannels from "@/routes/ingest-channels/ingest-channels.index.ts";
import patternLifecycle from "@/routes/pattern-lifecycle/pattern-lifecycle.index.ts";

import spaceInvites from "@/routes/space-invites/space-invites.index.ts";

const app = createApp();

configureOpenAPI(app);

// Static routes (non-OAuth2, plus non-standard OAuth like Plaid)
const routes = [
  health,
  telemetry,
  aiLLM,
  aiImg,
  aiVoice,
  linkPreview,
  agentToolsWebSearch,
  agentToolsWebRead,
  plaidOAuth,
  memory,
  memoryDump,
  blobs,
  whoami,
  meta,
  staticRoute,
  patterns,
  sandboxExec,
  webhooks,
  ingest,
  ingestChannels,
  spaceInvites,
  patternLifecycle,
];

routes.forEach((route) => {
  app.route("/", route);
});

// Dynamic OAuth2 provider routes (Google, Airtable, etc.)
const providerRouters = await buildProviderRouters();
providerRouters.forEach((router) => app.route("/", router));

// Shell serves at root, so add it last to catch all unmatched routes
app.route("/", shell);

export default app;

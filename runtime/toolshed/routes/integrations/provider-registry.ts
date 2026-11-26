/**
 * OAuth2 Provider Registry
 *
 * Auto-wires OAuth2 provider routes from ProviderDescriptor objects,
 * replacing per-provider boilerplate (handlers.ts, routes.ts, index.ts).
 *
 * To add a new OAuth2 provider, create a descriptor in its own directory
 * (see airtable.descriptor.ts or google.descriptor.ts for examples) and
 * add it to the DESCRIPTORS array below.
 *
 * Note: Plaid uses a non-standard OAuth flow and remains a manual import
 * in app.ts.
 */

import { AirtableDescriptor } from "./airtable-oauth/airtable.descriptor.ts";
import { DiscordDescriptor } from "./discord-oauth/discord.descriptor.ts";
import { GitHubDescriptor } from "./github-oauth/github.descriptor.ts";
import { GoogleDescriptor } from "./google-oauth/google.descriptor.ts";
import { LinearDescriptor } from "./linear-oauth/linear.descriptor.ts";
import { NotionDescriptor } from "./notion-oauth/notion.descriptor.ts";
import type { ProviderDescriptor } from "./oauth2-common/oauth2-common.types.ts";
import { createProviderRouters } from "./provider-routers.ts";
import { SpotifyDescriptor } from "./spotify-oauth/spotify.descriptor.ts";
import { StravaDescriptor } from "./strava-oauth/strava.descriptor.ts";
import { runtime } from "@/index.ts";

//
// Descriptor catalog — add new OAuth2 providers here
//

export const DESCRIPTORS: ProviderDescriptor[] = [
  GoogleDescriptor,
  AirtableDescriptor,
  GitHubDescriptor,
  NotionDescriptor,
  LinearDescriptor,
  SpotifyDescriptor,
  DiscordDescriptor,
  StravaDescriptor,
];

/**
 * Build routers for every registered OAuth2 provider, wired to the server's
 * runtime.
 */
export function buildProviderRouters() {
  return createProviderRouters(DESCRIPTORS, { runtime: () => runtime });
}

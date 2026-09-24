/**
 * Counts the GitHub organization's members and its outside collaborators. The
 * headline counts unique users across both rosters. Successive polls keep a
 * rolling history of each roster's size and chart them as two lines.
 */

import { REPO } from "../config.ts";
import type { Tile, TileView } from "../types.ts";
import { dashboardCacheFile } from "../history-files.ts";
import {
  escapeHtml,
  friendlyError,
  github,
  multiSparkline,
  thin,
} from "../lib.ts";
import { themedChartSeries } from "../theme.ts";

const MEMBERS_COLOR = "#58a6ff";
const COLLABORATORS_COLOR = "#a371f7";

const HISTORY_MAX_AGE_DAYS = 60;
const PLOT_POINTS = 500;

interface User {
  id: number;
}

type Point = { t: number; members: number; collaborators: number };

interface HistoryState {
  loaded: boolean;
  points: Point[];
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPoint = (value: unknown): value is Point =>
  typeof value === "object" && value !== null &&
  Number.isFinite((value as Point).t) &&
  isCount((value as Point).members) &&
  isCount((value as Point).collaborators);

const isUser = (value: unknown): value is User =>
  typeof value === "object" && value !== null &&
  Number.isSafeInteger((value as User).id) && (value as User).id > 0;

function historyFile(org: string): string {
  const fileOrg = org.toLowerCase().replace(/[^a-z0-9.-]/g, "_") ||
    "unknown";
  return dashboardCacheFile(
    `fabric-wall-github-members-${fileOrg}-history.json`,
  );
}

async function loadHistory(
  state: HistoryState,
  file: string,
): Promise<void> {
  try {
    const data = JSON.parse(await Deno.readTextFile(file));
    if (Array.isArray(data)) state.points.push(...data.filter(isPoint));
  } catch { /* an absent or unreadable file starts an empty history */ }
}

async function ensureLoaded(
  state: HistoryState,
  file: string,
): Promise<void> {
  if (state.loaded) return;
  state.loaded = true;
  await loadHistory(state, file);
}

async function saveHistory(points: Point[], file: string): Promise<void> {
  try {
    const tmp = `${file}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(points));
    await Deno.rename(tmp, file);
  } catch (error) {
    console.error(
      "github users: could not persist history:",
      error instanceof Error ? error.message : error,
    );
  }
}

// GitHub returns at most 100 users per page. The returned ids let the caller
// count each roster and keep the combined headline unique if membership changes
// between the two requests.
export async function organizationUserIds(
  org: string,
  roster: "members" | "outside_collaborators",
  token: string,
): Promise<Set<number>> {
  const ids = new Set<number>();
  for (let page = 1;; page++) {
    const batch = await github<unknown>(
      `orgs/${org}/${roster}?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || !batch.every(isUser)) {
      const label = roster === "members"
        ? "organization members"
        : "outside collaborators";
      throw new Error(`GitHub ${label} returned invalid user data`);
    }
    for (const member of batch) ids.add(member.id);
    if (batch.length < 100) return ids;
  }
}

export function createGithubMembers(): Tile {
  const history: HistoryState = { loaded: false, points: [] };
  return {
    label: "github users",
    intervalMs: 3_600_000,
    async collect(ctx): Promise<TileView> {
      const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
      if (!token) {
        return {
          status: "unknown",
          value: "—",
          sub: "set GH_TOKEN (needs org Members read)",
        };
      }

      const org = REPO.split("/")[0];
      const drill = {
        href: `https://github.com/orgs/${org}/people`,
        hint: "people ↗",
      };

      let memberIds: Set<number>;
      let collaboratorIds: Set<number>;
      try {
        [memberIds, collaboratorIds] = await Promise.all([
          organizationUserIds(org, "members", token),
          organizationUserIds(org, "outside_collaborators", token),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          "github users: could not read organization users:",
          message,
        );
        return {
          ...drill,
          status: "unknown",
          value: "—",
          sub: friendlyError(message),
        };
      }

      const members = memberIds.size;
      const collaborators = collaboratorIds.size;
      const people = new Set([...memberIds, ...collaboratorIds]).size;
      const now = Date.now();

      const file = historyFile(org);
      await ensureLoaded(history, file);
      history.points.push({ t: now, members, collaborators });
      history.points.sort((a, b) => a.t - b.t);
      const cutoff = now - HISTORY_MAX_AGE_DAYS * 86_400_000;
      while (history.points.length && history.points[0].t < cutoff) {
        history.points.shift();
      }
      await saveHistory(history.points, file);

      const spanMs = history.points.length >= 2
        ? history.points[history.points.length - 1].t - history.points[0].t
        : 0;
      const plot = thin(history.points, PLOT_POINTS);
      const membersSeries = themedChartSeries(MEMBERS_COLOR);
      const collaboratorsSeries = themedChartSeries(COLLABORATORS_COLOR);
      const chart = multiSparkline(
        [
          {
            vals: plot.map((point) => point.members),
            ...membersSeries,
            label: String(members),
          },
          {
            vals: plot.map((point) => point.collaborators),
            ...collaboratorsSeries,
            label: String(collaborators),
          },
        ],
        { fade: true },
      );
      const swatch = (color: string) =>
        `<span class="swatch" style="background:${escapeHtml(color)}"></span>`;
      const subline = chart
        ? `<p class="sub" title="members · collaborators">${swatch(membersSeries.color)} members · ${
          swatch(collaboratorsSeries.color)
        } collaborators</p>`
        : `<p class="sub" title="members ${members} · collaborators ${collaborators}">${swatch(membersSeries.color)} members ${members} · ${
          swatch(collaboratorsSeries.color)
        } collaborators ${collaborators}</p>`;

      return {
        ...drill,
        status: "good",
        value: String(people),
        extra: subline + chart,
        duration: spanMs,
      };
    },
  };
}

export const githubMembers = createGithubMembers();

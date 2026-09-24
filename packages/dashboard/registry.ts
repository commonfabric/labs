/**
 * Names every tile the dashboard runs, and is the only place any of them is
 * registered. A tile is added by importing it here and listing it below, and
 * removed by deleting its line.
 */

import type { Tile } from "./types.ts";

import { benchmark, keyBenchmarks } from "./tiles/benchmark.ts";
import { labsCiDuration, loomCiDuration } from "./tiles/ci-duration.ts";
import { labsCiTrust, loomCiTrust } from "./tiles/ci-trust.ts";
import { ciHealth } from "./tiles/ci-health.ts";
import { coverageDebt } from "./tiles/coverage-debt.ts";
import { cubicSpend } from "./tiles/cubic-spend.ts";
import { dau } from "./tiles/dau.ts";
import { discordOnline } from "./tiles/discord-online.ts";
import { emptyTile } from "./tiles/empty.ts";
import { gcpSpend } from "./tiles/gcp-spend.ts";
import { githubCiSpend } from "./tiles/github-ci-spend.ts";
import { githubMembers } from "./tiles/github-members.ts";
import { modelSpend } from "./tiles/model-spend.ts";
import { prodErrors } from "./tiles/prod-errors.ts";
import { prodUptime } from "./tiles/prod-uptime.ts";
import { recentRuns } from "./tiles/recent-runs.ts";
import { testFlakes } from "./tiles/test-flakes.ts";
import { testSelection } from "./tiles/test-selection.ts";

/** Tiles in grid order, followed by full-width tiles in display order. */
export const TILES: Tile[] = [
  ciHealth,
  labsCiTrust,
  labsCiDuration,
  benchmark,

  emptyTile,
  loomCiTrust,
  loomCiDuration,
  keyBenchmarks,

  testFlakes,
  testSelection,
  coverageDebt,
  prodErrors,

  dau,
  discordOnline,
  githubMembers,
  prodUptime,

  cubicSpend,
  githubCiSpend,
  modelSpend,
  gcpSpend,

  recentRuns,
];

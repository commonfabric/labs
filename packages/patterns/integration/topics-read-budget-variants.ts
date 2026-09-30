/**
 * The regression variants of the Topics read budget, each built here in test
 * code over the unmodified Topics sources. A variant starts extra work beside
 * the demanded lifts, so that `--derive-limits` can show each limit it derives
 * exceeded by a regression that grows the count the limit gates.
 * `topics-read-budget.ts` assigns each limit its variant.
 */

import { isModule, type Module, type Runtime } from "@commonfabric/runner";

import type { ProbeCase } from "./topics-cost-cases.ts";
import {
  DEFAULT_COMMENTS_PER_TOPIC,
  DEFAULT_LINKS_PER_TOPIC,
  type TopicsVariant,
} from "./topics-headless-fixture.ts";

/** The variants, by name, each built for the case it runs under. */
export const READ_BUDGET_VARIANTS = {
  /**
   * A scan regression: one lift over the board that reads every topic's
   * title, the title of each topic it mentions, and every stamp on its
   * comments and links. Each warm update writes one of those, so the lift runs
   * again in every phase and reads the whole board each time.
   */
  scan: (): TopicsVariant => async (runtime) => {
    const scan = await compileLift(runtime, SCAN_MODULE);
    return ({ tx, seeded, output }) => [
      runtime.run(tx, scan, { topics: seeded.board }, output("board-scan")),
    ];
  },

  /**
   * A growth in actions on a board: a second instance of each demanded lift,
   * the pivot among them, over the same inputs.
   */
  "duplicate-demand": (): TopicsVariant => () =>
    Promise.resolve(({ startDemandedLifts }) =>
      startDemandedLifts("duplicate")
    ),

  /**
   * A growth in actions on a thread: a lift for each comment position and
   * each link position the case's fixture gives a topic, on every topic.
   */
  "per-record": ({ options }: ProbeCase): TopicsVariant => async (runtime) => {
    const stamp = await compileLift(runtime, RECORD_MODULE);
    const positions = {
      comments: options.commentsPerTopic ?? DEFAULT_COMMENTS_PER_TOPIC,
      links: options.linksPerTopic ?? DEFAULT_LINKS_PER_TOPIC,
    };
    return ({ tx, seeded, output }) =>
      seeded.topics.flatMap((topic, index) =>
        (["comments", "links"] as const).flatMap((field) =>
          Array.from(
            { length: positions[field] },
            (_, position) =>
              runtime.run(
                tx,
                stamp,
                { record: topic.key(field).key(position) },
                output(`record-${index}-${field}-${position}`),
              ),
          )
        )
      );
  },
} satisfies Readonly<Record<string, (probeCase: ProbeCase) => TopicsVariant>>;

/** The name of one read-budget variant. */
export type ReadBudgetVariantName = keyof typeof READ_BUDGET_VARIANTS;

/** A module holding one lift, compiled for a variant. */
interface LiftModule {
  /** The module's path in the program it is compiled as. */
  readonly path: string;

  /** The lift's authored name. */
  readonly name: string;

  /** The module's source. */
  readonly contents: string;
}

/** The scan variant's lift. */
const SCAN_MODULE: LiftModule = {
  path: "/topics-read-budget/scan.tsx",
  name: "boardScan",
  contents: [
    `import { lift } from "commonfabric";`,
    `interface ScannedTopic {`,
    `  title: string;`,
    `  mentions: { title: string }[];`,
    `  comments: { sentAt: number; editedAt?: number; removedAt?: number }[];`,
    `  links: { addedAt?: number; removedAt?: number }[];`,
    `}`,
    `const boardScan = lift(`,
    `  ({ topics }: { topics: ScannedTopic[] }): number => {`,
    `    let total = 0;`,
    `    for (const topic of topics) {`,
    `      total += topic.title.length;`,
    `      for (const mention of topic.mentions) {`,
    `        total += mention.title.length;`,
    `      }`,
    `      for (const c of topic.comments) {`,
    `        total += c.sentAt + (c.editedAt ?? 0) + (c.removedAt ?? 0);`,
    `      }`,
    `      for (const l of topic.links) {`,
    `        total += (l.addedAt ?? 0) + (l.removedAt ?? 0);`,
    `      }`,
    `    }`,
    `    return total;`,
    `  },`,
    `);`,
    `export const scan = boardScan;`,
  ].join("\n"),
};

/** The per-record variant's lift. */
const RECORD_MODULE: LiftModule = {
  path: "/topics-read-budget/record.tsx",
  name: "recordStamp",
  contents: [
    `import { lift } from "commonfabric";`,
    `interface StampedRecord {`,
    `  sentAt?: number;`,
    `  editedAt?: number;`,
    `  addedAt?: number;`,
    `  removedAt?: number;`,
    `}`,
    `const recordStamp = lift(`,
    `  ({ record }: { record: StampedRecord }): number =>`,
    `    Math.max(`,
    `      record.sentAt ?? 0,`,
    `      record.editedAt ?? 0,`,
    `      record.addedAt ?? 0,`,
    `      record.removedAt ?? 0,`,
    `    ),`,
    `);`,
    `export const stamp = recordStamp;`,
  ].join("\n"),
};

/**
 * Helper for the variants above, which compiles `module` in `runtime` and
 * returns its lift from the runtime's artifact index.
 *
 * @throws Error when the compiled module defines no such lift.
 */
async function compileLift(
  runtime: Runtime,
  { path, name, contents }: LiftModule,
): Promise<Module> {
  const { patternManager } = runtime;
  const evaluated = await patternManager.compileAndRegisterModules({
    main: path,
    files: [{ name: path, contents }],
  });
  const identity = [...evaluated.sourcePathByIdentity ?? []]
    .find(([, source]) => source === path)?.[0];
  const artifact = identity === undefined
    ? undefined
    : patternManager.artifactFromIdentitySync(identity, name);
  if (!isModule(artifact)) {
    throw new Error(
      `The variant module \`${path}\` defines no lift \`${name}\`.`,
    );
  }
  return artifact;
}

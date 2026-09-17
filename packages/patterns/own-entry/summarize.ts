/**
 * Reads the run records `measure-start.ts` wrote and prints the tables the
 * experiment's questions ask for. Reads only `*.result.json` files, so every
 * figure it prints is in a committed record.
 *
 * Usage: deno run -A packages/patterns/own-entry/summarize.ts <dir>...
 */

import { ARMS } from "./arms.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const dirs = Deno.args.length > 0 ? Deno.args : ["experiment-output/runs"];
const runs: Json[] = [];
for (const dir of dirs) {
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.name.endsWith(".result.json")) continue;
    const record = JSON.parse(Deno.readTextFileSync(`${dir}/${entry.name}`));
    record.file = `${dir}/${entry.name}`;
    runs.push(record);
  }
}
const ARM_ORDER = [
  "current",
  "q2-unread",
  "q2-read-one",
  "q3-index",
  "q4-handed",
  "q6-copies",
  "q7-board-name",
];
runs.sort((left, right) =>
  ARM_ORDER.indexOf(left.arm) - ARM_ORDER.indexOf(right.arm) ||
  left.N - right.N
);

const n = (value: number | undefined) =>
  value === undefined ? "-" : value.toLocaleString("en-US");
const pad = (text: string | number, width: number) =>
  String(text).padStart(width);
const padRight = (text: string | number, width: number) =>
  String(text).padEnd(width);

console.log(`# Runs read: ${runs.length}`);
console.log(
  `# Commits: ${[...new Set(runs.map((run) => run.head))].join(" ")}`,
);
console.log(
  `# Deno ${[...new Set(runs.map((run) => run.deno))].join(" ")}; ` +
    `experimental ${JSON.stringify(runs[0]?.experimental)}`,
);

console.log(`
## Arms
`);
for (const arm of ARM_ORDER) {
  const run = runs.find((candidate) => candidate.arm === arm);
  if (run === undefined) continue;
  console.log(`- \`${arm}\` (${run.base}): ${ARMS[arm].what}`);
}

console.log(`
## Starting one topic: what the server delivered to a fresh runtime

\`other\` counts documents belonging to another topic (its result, argument or
pattern document, or a document whose \`result\` backlinks reach one of those).
\`self\`, \`board\` and \`schema\` count the topic's own family, the board's, and
content-addressed schema documents. \`startMs\` is wall-clock for
\`runtime.start\` plus \`idle()\` plus \`storage.synced()\`.
`);
console.log(
  `${padRight("arm", 14)} ${pad("N", 4)} ${pad("other", 6)} ${
    pad("otherBytes", 11)
  } ${pad("docs", 5)} ${pad("bytes", 10)} ${pad("self", 5)} ${
    pad("board", 6)
  } ${pad("schema", 7)} ${pad("startMs", 8)}  checks (referencedBy, shortName)`,
);
for (const run of runs) {
  const phase = run.phases.start;
  console.log(
    `${padRight(run.arm, 14)} ${pad(run.N, 4)} ${pad(phase.otherDocs, 6)} ${
      pad(n(phase.otherBytes), 11)
    } ${pad(phase.docs, 5)} ${pad(n(phase.bytes), 10)} ${
      pad(phase.selfDocs + phase.selfFamilyDocs, 5)
    } ${pad(phase.boardDocs + phase.boardFamilyDocs, 6)} ${
      pad(phase.schemaDocs, 7)
    } ${pad(run.ms.start, 8)}  ${
      JSON.stringify({
        referencedBy: run.checksB?.referencedBy,
        shortName: run.checksB?.shortName,
        ...(run.checksB?.collectionName === undefined
          ? {}
          : { collectionName: run.checksB.collectionName }),
      })
    }`,
  );
}

console.log(`
## The replayed demand (the #7439 method) against the same start

Each replay root is one \`session.queryGraph\` the rig issued on the same store:
the topic's argument document under the schema recorded on its argument link
(\`whole as recorded\`), and each declared input's document under that input's
property schema.
`);
console.log(
  `${padRight("arm", 14)} ${pad("N", 4)} ${padRight("root", 28)} ${
    pad("other", 6)
  } ${pad("otherBytes", 11)} ${pad("docs", 5)} ${pad("bytes", 10)}`,
);
for (const run of runs) {
  console.log(
    `${padRight(run.arm, 14)} ${pad(run.N, 4)} ${
      padRight("START (measured)", 28)
    } ${pad(run.phases.start.otherDocs, 6)} ${
      pad(n(run.phases.start.otherBytes), 11)
    } ${pad(run.phases.start.docs, 5)} ${pad(n(run.phases.start.bytes), 10)}`,
  );
  for (
    const [root, figures] of Object.entries(run.replay) as [string, Json][]
  ) {
    console.log(
      `${padRight("", 14)} ${pad("", 4)} ${padRight(`replay ${root}`, 28)} ${
        pad(figures.otherDocs, 6)
      } ${pad(n(figures.otherBytes), 11)} ${pad(figures.docs, 5)} ${
        pad(n(figures.bytes), 10)
      }`,
    );
  }
}

console.log(`
## What the board pays

\`op-add\` is one \`addTopic\` at that size, \`op-mention\` one \`mention\` that
changes topic 0's inbound set, each measured with the board's derivations held
live and its frames captured on their own. \`commits\` and \`ops\` are the
transactions the client sent and the operations in them.
`);
console.log(
  `${padRight("arm", 14)} ${pad("N", 4)} ${padRight("op", 11)} ${
    pad("commits", 8)
  } ${pad("ops", 6)} ${pad("outBytes", 10)} ${pad("docsIn", 7)} ${
    pad("bytesIn", 10)
  } ${pad("ms", 7)}`,
);
for (const run of runs) {
  for (
    const [label, key, time] of [
      ["add", "op-add", run.ms.add],
      ["mention", "op-mention", run.ms.mention],
    ] as [string, string, number][]
  ) {
    const phase = run.phases[key];
    console.log(
      `${padRight(run.arm, 14)} ${pad(run.N, 4)} ${padRight(label, 11)} ${
        pad(phase.commits, 8)
      } ${pad(phase.commitOps, 6)} ${pad(n(phase.bytesOut), 10)} ${
        pad(phase.docs, 7)
      } ${pad(n(phase.bytes), 10)} ${pad(time, 7)}`,
    );
  }
}

console.log(`
## Time

\`buildMs\` files N topics and makes the mentions, and is the rig's cost rather
than a product figure; \`deferred\` means the board's outputs were demanded once
at the end of the build instead of throughout. \`compileB\` compiles the program
in the fresh runtime, before the start. \`pull\` is \`cell.pull()\` on the topic's
schema-less result cell, which is what \`PiecesController.startPiece\` does after
\`runtime.start\`.
`);
console.log(
  `${padRight("arm", 14)} ${pad("N", 4)} ${pad("buildMs", 9)} ${
    padRight("deferred", 9)
  } ${pad("compileB", 9)} ${pad("startMs", 8)} ${pad("pullMs", 7)} ${
    pad("pullOther", 10)
  } ${pad("pullDocs", 9)}`,
);
for (const run of runs) {
  const pull = run.phases.pull;
  console.log(
    `${padRight(run.arm, 14)} ${pad(run.N, 4)} ${pad(n(run.ms.build), 9)} ${
      padRight(run.deferDemand === true ? "yes" : "no", 9)
    } ${pad(run.ms.compileB, 9)} ${pad(run.ms.start, 8)} ${
      pad(run.ms.pull ?? "-", 7)
    } ${pad(pull === undefined ? "-" : pull.otherDocs, 10)} ${
      pad(pull === undefined ? "-" : pull.docs, 9)
    }`,
  );
}

console.log(`
## The largest documents one start received
`);
for (const run of runs) {
  console.log(`### ${run.arm}, N=${run.N} (${run.file})`);
  for (const document of run.phases.start.largest) {
    console.log(
      `  ${pad(n(document.bytes), 9)}  ${padRight(document.whose, 12)} ${
        document.scope === "space" ? "" : document.scope + " "
      }${document.id}`,
    );
  }
}

const moved = runs.filter((run) => run.forward === true);
if (moved.length > 0) {
  console.log(`
## After a move that left a forwarding link

The board's list entry for topic 0 was rewritten to a document whose only
content is a link to topic 0, so the board holds an address that forwards.
\`referencedBy\` and \`shortName\` are what the topic computed after the move, in
the fresh runtime.
`);
  console.log(
    `${padRight("arm", 14)} ${pad("N", 4)} ${padRight("forwarder", 22)} ${
      padRight("topic at", 22)
    } ${pad("refBy", 6)} ${pad("name", 6)} ${pad("other", 6)}`,
  );
  for (const run of moved) {
    console.log(
      `${padRight(run.arm, 14)} ${pad(run.N, 4)} ${
        padRight(run.movedTo.forwarderId.slice(0, 20), 22)
      } ${padRight(run.movedTo.topicIsAt.slice(0, 20), 22)} ${
        pad(run.checksB?.referencedBy ?? "-", 6)
      } ${pad(run.checksB?.shortName ?? "-", 6)} ${
        pad(run.phases.start.otherDocs, 6)
      }`,
    );
  }
}

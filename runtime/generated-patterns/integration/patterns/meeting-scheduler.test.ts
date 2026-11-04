import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const meetingSchedulerScenario: PatternIntegrationScenario<
  {
    participants?: { id?: string; name?: string }[];
    slots?: Array<string | { id?: string; label?: string }>;
  }
> = {
  name: "meeting scheduler gathers votes for proposed slots",
  module: new URL("./meeting-scheduler.pattern.ts", import.meta.url),
  exportName: "meetingSchedulerPattern",
  steps: [
    {
      expect: [
        {
          path: "slots",
          value: [
            { id: "tuesday-0900", label: "Tuesday 09:00" },
            { id: "tuesday-1400", label: "Tuesday 14:00" },
            { id: "wednesday-1000", label: "Wednesday 10:00" },
          ],
        },
        {
          path: "slotTallies",
          value: [
            {
              slotId: "tuesday-0900",
              slotLabel: "Tuesday 09:00",
              yes: 0,
              maybe: 0,
              no: 0,
              pending: [
                "Alex Rivera",
                "Blair Chen",
                "Casey Morgan",
              ],
            },
            {
              slotId: "tuesday-1400",
              slotLabel: "Tuesday 14:00",
              yes: 0,
              maybe: 0,
              no: 0,
              pending: [
                "Alex Rivera",
                "Blair Chen",
                "Casey Morgan",
              ],
            },
            {
              slotId: "wednesday-1000",
              slotLabel: "Wednesday 10:00",
              yes: 0,
              maybe: 0,
              no: 0,
              pending: [
                "Alex Rivera",
                "Blair Chen",
                "Casey Morgan",
              ],
            },
          ],
        },
        {
          path: "consensus",
          value: {
            slotId: "tuesday-0900",
            slotLabel: "Tuesday 09:00",
            yes: 0,
            maybe: 0,
            no: 0,
            outstanding: 3,
            outstandingNames: [
              "Alex Rivera",
              "Blair Chen",
              "Casey Morgan",
            ],
            status: "pending",
            participantCount: 3,
          },
        },
        {
          path: "consensusSummary",
          value: "Consensus slot: Tuesday 09:00 (0 yes)",
        },
        {
          path: "outstandingSummary",
          value:
            "Outstanding voters: 3 (Alex Rivera, Blair Chen, Casey Morgan)",
        },
        { path: "history", value: [] },
        { path: "latestVote", value: null },
        { path: "latestSlotUpdate", value: null },
        {
          path: "votes",
          value: {
            "tuesday-0900": {},
            "tuesday-1400": {},
            "wednesday-1000": {},
          },
        },
      ],
    },
    {
      events: [
        {
          stream: "controls.proposeSlot",
          payload: { label: "Thursday 09:30" },
        },
      ],
      expect: [
        {
          path: "slots",
          value: [
            { id: "tuesday-0900", label: "Tuesday 09:00" },
            { id: "tuesday-1400", label: "Tuesday 14:00" },
            { id: "wednesday-1000", label: "Wednesday 10:00" },
            { id: "thursday-09-30", label: "Thursday 09:30" },
          ],
        },
        {
          path: "slotTallies",
          value: [
            {
              slotId: "tuesday-0900",
              slotLabel: "Tuesday 09:00",
              yes: 0,
              maybe: 0,
              no: 0,
              pending: [
                "Alex Rivera",
                "Blair Chen",
                "Casey Morgan",
              ],
            },
            {
              slotId: "tuesday-1400",
              slotLabel: "Tuesday 14:00",
              yes: 0,
              maybe: 0,
              no: 0,
              pending: [
                "Alex Rivera",
                "Blair Chen",
                "Casey Morgan",
              ],
            },
            {
              slotId: "wednesday-1000",
              slotLabel: "Wednesday 10:00",
              yes: 0,
              maybe: 0,
              no: 0,
              pending: [
                "Alex Rivera",
                "Blair Chen",
                "Casey Morgan",
              ],
            },
            {
              slotId: "thursday-09-30",
              slotLabel: "Thursday 09:30",
              yes: 0,
              maybe: 0,
              no: 0,
              pending: [
                "Alex Rivera",
                "Blair Chen",
                "Casey Morgan",
              ],
            },
          ],
        },
        {
          path: "history",
          value: ["Proposed slot Thursday 09:30"],
        },
        {
          path: "latestSlotUpdate",
          value: {
            slotId: "thursday-09-30",
            label: "Thursday 09:30",
            mode: "added",
          },
        },
        {
          path: "votes",
          value: {
            "tuesday-0900": {},
            "tuesday-1400": {},
            "wednesday-1000": {},
            "thursday-09-30": {},
          },
        },
      ],
    },
    {
      events: [
        {
          stream: "controls.castVote",
          payload: {
            participant: "Alex Rivera",
            slot: "Tuesday 09:00",
            vote: "yes",
          },
        },
        {
          stream: "controls.castVote",
          payload: {
            participant: "blair-chen",
            slot: "Thursday 09:30",
            vote: "yes",
          },
        },
        {
          stream: "controls.castVote",
          payload: {
            participant: "Casey Morgan",
            slot: "Thursday 09:30",
            vote: "maybe",
          },
        },
      ],
      expect: [
        {
          path: "votes",
          value: {
            "tuesday-0900": { "alex-rivera": "yes" },
            "tuesday-1400": {},
            "wednesday-1000": {},
            "thursday-09-30": {
              "blair-chen": "yes",
              "casey-morgan": "maybe",
            },
          },
        },
        {
          path: "slotTallies",
          value: [
            {
              slotId: "tuesday-0900",
              slotLabel: "Tuesday 09:00",
              yes: 1,
              maybe: 0,
              no: 0,
              pending: ["Blair Chen", "Casey Morgan"],
            },
            {
              slotId: "tuesday-1400",
              slotLabel: "Tuesday 14:00",
              yes: 0,
              maybe: 0,
              no: 0,
              pending: [
                "Alex Rivera",
                "Blair Chen",
                "Casey Morgan",
              ],
            },
            {
              slotId: "wednesday-1000",
              slotLabel: "Wednesday 10:00",
              yes: 0,
              maybe: 0,
              no: 0,
              pending: [
                "Alex Rivera",
                "Blair Chen",
                "Casey Morgan",
              ],
            },
            {
              slotId: "thursday-09-30",
              slotLabel: "Thursday 09:30",
              yes: 1,
              maybe: 1,
              no: 0,
              pending: ["Alex Rivera"],
            },
          ],
        },
        {
          path: "consensus",
          value: {
            slotId: "thursday-09-30",
            slotLabel: "Thursday 09:30",
            yes: 1,
            maybe: 1,
            no: 0,
            outstanding: 1,
            outstandingNames: ["Alex Rivera"],
            status: "pending",
            participantCount: 3,
          },
        },
        {
          path: "consensusSummary",
          value: "Consensus slot: Thursday 09:30 (1 yes)",
        },
        {
          path: "outstandingSummary",
          value: "Outstanding voters: 1 (Alex Rivera)",
        },
        {
          path: "history",
          value: [
            "Proposed slot Thursday 09:30",
            "Alex Rivera voted yes for Tuesday 09:00",
            "Blair Chen voted yes for Thursday 09:30",
            "Casey Morgan voted maybe for Thursday 09:30",
          ],
        },
        {
          path: "latestVote",
          value: {
            participantId: "casey-morgan",
            participantName: "Casey Morgan",
            slotId: "thursday-09-30",
            slotLabel: "Thursday 09:30",
            vote: "maybe",
            yesCount: 1,
            maybeCount: 1,
            noCount: 0,
          },
        },
        {
          path: "latestSlotUpdate",
          value: {
            slotId: "thursday-09-30",
            label: "Thursday 09:30",
            mode: "added",
          },
        },
      ],
    },
  ],
};

export const scenarios = [meetingSchedulerScenario];

describe("meeting-scheduler", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});

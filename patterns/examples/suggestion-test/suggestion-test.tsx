import { Default, NAME, pattern, UI, Writable } from "commonfabric";
import Suggestion from "../../system/suggestion/suggestion.tsx";
import Summary from "../suggestable/summary.tsx";
import Checklist from "../suggestable/checklist.tsx";
import Question from "../suggestable/question.tsx";
import Diagram from "../suggestable/diagram.tsx";
import BudgetPlanner from "../suggestable/budget-planner.tsx";
import PeopleList from "../suggestable/people-list.tsx";
import EventList from "../suggestable/event-list.tsx";

export default pattern<{ title: string | Default<"Suggestion Tester"> }>(
  ({ title }) => {
    const suggestion = Suggestion({
      situation: "gimme counter plz",
      context: {},
      initialResults: [],
    });

    const suggestion2 = Suggestion({
      situation: "gimme note with the attached content",
      context: {
        content: "This is the expected content",
        value: new Writable(0),
      },
      initialResults: [],
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h1>Suggestion Tester</h1>
          <h2>Counter</h2>
          {suggestion}

          <h2>Note</h2>
          {suggestion2}
          <hr />

          <Summary
            topic="Count items in the list and categorize"
            context={{ list: ["baboon", "fish", "donkey", "horse"] }}
          />

          <hr />

          <Checklist
            topic="What do I need to do to go see these animals?"
            context={{ list: ["baboon", "fish", "donkey", "horse"] }}
          />

          <hr />

          <Question
            topic="I'm looking to improve my fitness level"
            context={{ list: ["calisthenics", "yoga"] }}
          />

          <hr />

          <Diagram
            topic="Diagram of the animal kingdom"
            context={{ list: ["baboon", "fish", "donkey", "horse"] }}
          />

          <hr />

          <PeopleList />

          <hr />

          <EventList />

          <hr />

          <BudgetPlanner maxAmount={1000} topic="Weekend trip" />
        </div>
      ),
    };
  },
);

import { Default, NAME, pattern, UI, type VNode, Writable } from "commonfabric";

type Input = {
  selected: Writable<string | Default<"opt_1">>;
  numericChoice: Writable<number | Default<1>>;
  category: Writable<string | Default<"Other">>;
  activeTab: Writable<string | Default<"tab1">>;
};

export type Result = {
  [NAME]: string;
  [UI]: VNode;
  selected: string;
  numericChoice: number;
  category: string;
  activeTab: string;
};

export default pattern<Input, Result>(
  ({ selected, numericChoice, category, activeTab }) => {
    return {
      [NAME]: "cf-select demo",
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <h3>cf-select Component Demo</h3>

          <cf-card>
            <h4>String Values</h4>
            <p>
              cf-select uses an `items` attribute with {`{label, value}`}{" "}
              objects
            </p>
            <cf-select
              items={[
                { label: "Option 1", value: "opt_1" },
                { label: "Option 2", value: "opt_2" },
                { label: "Option 3", value: "opt_3" },
              ]}
              $value={selected}
            />
            <p>Selected: {selected}</p>
          </cf-card>

          <cf-card>
            <h4>
              <code>cf-autocomplete</code>
            </h4>
            <cf-autocomplete
              items={[
                { label: "Option 1", value: "opt_1" },
                { label: "Option 2", value: "opt_2" },
                { label: "Option 3", value: "opt_3" },
              ]}
              $value={selected}
            />
          </cf-card>

          <cf-card>
            <h4>
              <code>cf-radio-group</code>
            </h4>
            <cf-radio-group
              $value={selected}
              items={[
                { label: "Option 1", value: "opt_1" },
                { label: "Option 2", value: "opt_2" },
                { label: "Option 3", value: "opt_3" },
              ]}
              orientation="horizontal"
            />
          </cf-card>

          <cf-card>
            <h4>Numeric Values</h4>
            <p>Values can be any type, not just strings</p>
            <cf-select
              items={[
                { label: "First Item", value: 1 },
                { label: "Second Item", value: 2 },
                { label: "Third Item", value: 3 },
              ]}
              $value={numericChoice}
            />
            <p>Selected number: {numericChoice}</p>
          </cf-card>

          <cf-card>
            <h4>Common Categories Example</h4>
            <cf-select
              $value={category}
              items={[
                { label: "Produce", value: "Produce" },
                { label: "Dairy", value: "Dairy" },
                { label: "Meat", value: "Meat" },
                { label: "Bakery", value: "Bakery" },
                { label: "Other", value: "Other" },
              ]}
            />
            <p>Selected category: {category}</p>
          </cf-card>

          <cf-card>
            <h4>
              <code>cf-tabs</code>
            </h4>
            <p>Tabs use $value binding for the active tab</p>
            <cf-tabs $value={activeTab}>
              <cf-tab-list>
                <cf-tab value="tab1">First Tab</cf-tab>
                <cf-tab value="tab2">Second Tab</cf-tab>
                <cf-tab value="tab3">Third Tab</cf-tab>
              </cf-tab-list>
              <cf-tab-panel value="tab1">
                <p>Content for the first tab panel.</p>
              </cf-tab-panel>
              <cf-tab-panel value="tab2">
                <p>Content for the second tab panel.</p>
              </cf-tab-panel>
              <cf-tab-panel value="tab3">
                <p>Content for the third tab panel.</p>
              </cf-tab-panel>
            </cf-tabs>
            <p>Active tab: {activeTab}</p>
          </cf-card>
        </cf-vstack>
      ),
      selected,
      numericChoice,
      category,
      activeTab,
    };
  },
);

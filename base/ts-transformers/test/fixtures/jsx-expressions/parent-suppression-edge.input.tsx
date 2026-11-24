import { pattern, UI } from "commonfabric";

interface State {
  user: {
    name: string;
    age: number;
    email: string;
    profile: {
      bio: string;
      location: string;
      website: string;
    };
    settings: {
      theme: string;
      notifications: boolean;
      privacy: string;
    };
  };
  config: {
    theme: {
      colors: {
        primary: string;
        secondary: string;
        background: string;
      };
      fonts: {
        heading: string;
        body: string;
        mono: string;
      };
      spacing: {
        small: number;
        medium: number;
        large: number;
      };
    };
    features: {
      darkMode: boolean;
      animations: boolean;
      betaFeatures: boolean;
    };
  };
  data: {
    items: Array<{
      id: number;
      name: string;
      value: number;
    }>;
    totals: {
      count: number;
      sum: number;
      average: number;
    };
  };
  deeply: {
    nested: {
      structure: {
        with: {
          many: {
            levels: {
              value: string;
              count: number;
            };
          };
        };
      };
    };
  };
  arrays: {
    first: string[];
    second: number[];
    nested: Array<{
      items: string[];
      count: number;
    }>;
  };
}

// FIXTURE: parent-suppression-edge
// Verifies: property access suppression -- sibling properties share a captured parent in a lift-applied computation
//   {state.user.name} ... {state.user.age} → individual .key() or shared lift(...)({ user: {...} })
//   {state.config.theme.colors.primary}    → lift-applied computation with deeply nested capture
// Context: Tests that the transformer correctly deduplicates and suppresses parent captures
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>Same Base, Different Properties</h3>
        {/* Multiple accesses to same object in one expression */}
        <p>
          User info: {state.user.name} (age: {state.user.age}, email:{" "}
          {state.user.email})
        </p>

        {/* String concatenation with multiple property accesses */}
        <p>
          Full profile:{" "}
          {state.user.name + " from " + state.user.profile.location + " - " +
            state.user.profile.bio}
        </p>

        {/* Arithmetic with multiple properties from same base */}
        <p>
          Age calculation: {state.user.age * 12} months, or{" "}
          {state.user.age * 365} days
        </p>

        <h3>Deeply Nested Property Chains</h3>
        {/* Multiple references to deeply nested object */}
        <p>
          Theme: {state.config.theme.colors.primary} /{" "}
          {state.config.theme.colors.secondary} on{" "}
          {state.config.theme.colors.background}
        </p>

        {/* Fonts from same nested structure */}
        <p>
          Typography: Headings in {state.config.theme.fonts.heading}, body in
          {" "}
          {state.config.theme.fonts.body}, code in{" "}
          {state.config.theme.fonts.mono}
        </p>

        {/* Mixed depth accesses */}
        <p>
          Config summary: Dark mode{" "}
          {state.config.features.darkMode ? "enabled" : "disabled"} with{" "}
          {state.config.theme.colors.primary} primary color
        </p>

        <h3>Very Deep Nesting with Multiple References</h3>
        {/* Accessing different properties at same deep level */}
        <p>
          Deep value: {state.deeply.nested.structure.with.many.levels.value}
          {" "}
          (count: {state.deeply.nested.structure.with.many.levels.count})
        </p>

        {/* Mixed depth from same root */}
        <p>
          Mixed depths: {state.deeply.nested.structure.with.many.levels.value}
          {" "}
          in {state.deeply.nested.structure.with.many.levels.count} items
        </p>

        <h3>Arrays with Shared Base</h3>
        {/* Multiple array properties */}
        <p>
          Array info: First has {state.arrays.first.length} items, second has
          {" "}
          {state.arrays.second.length} items
        </p>

        {/* Nested array access with shared base */}
        <p>
          Nested: {state.arrays.nested[0]!.items.length} items in first, count is
          {" "}
          {state.arrays.nested[0]!.count}
        </p>

        {/* Array and property access mixed */}
        <p>
          First item: {state.arrays.first[0]} (total:{" "}
          {state.arrays.first.length})
        </p>

        <h3>Complex Expressions with Shared Bases</h3>
        {/* Conditional with multiple property accesses */}
        <p>
          Status: {state.user.settings.notifications
            ? state.user.name + " has notifications on with " +
              state.user.settings.theme + " theme"
            : state.user.name + " has notifications off"}
        </p>

        {/* Computed expression with shared base */}
        <p>
          Spacing calc: {state.config.theme.spacing.small +
            state.config.theme.spacing.medium +
            state.config.theme.spacing.large} total
        </p>

        {/* Boolean expressions with multiple properties */}
        <p>
          Features:{" "}
          {state.config.features.darkMode && state.config.features.animations
            ? "Full features"
            : "Limited features"}
        </p>

        <h3>Method Calls on Shared Bases</h3>
        {/* Multiple method calls on properties from same base */}
        <p>
          Formatted: {state.user.name.toUpperCase()} -{" "}
          {state.user.email.toLowerCase()}
        </p>

        {/* Property access and method calls mixed */}
        <p>
          Profile length: {state.user.profile.bio.length} chars in bio,{" "}
          {state.user.profile.location.length} chars in location
        </p>

        <h3>Edge Cases for Parent Suppression</h3>
        {/* Same intermediate parent used differently */}
        <p>
          User settings: Theme is {state.user.settings.theme} with privacy{" "}
          {state.user.settings.privacy}
        </p>

        {/* Parent and child both used */}
        <p>
          Data summary: {state.data.items.length} items with average{" "}
          {state.data.totals.average}
        </p>

        {/* Multiple levels of the same chain */}
        <p>
          Nested refs: {state.config.theme.colors.primary} in{" "}
          {state.config.theme.fonts.body} with{" "}
          {state.config.features.animations ? "animations" : "no animations"}
        </p>

        <h3>Extreme Parent Suppression Test</h3>
        {/* Using every level of a deep chain */}
        <p>
          All levels: Root: {state.deeply ? "exists" : "missing"}, Nested:{" "}
          {state.deeply.nested ? "exists" : "missing"}, Value:{" "}
          {state.deeply.nested.structure.with.many.levels.value}
        </p>
      </div>
    ),
  };
});

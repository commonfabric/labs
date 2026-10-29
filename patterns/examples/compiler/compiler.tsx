import {
  compileAndRun,
  Default,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commonfabric";

type Input = {
  code:
    | string
    | Default<
      'import { computed, Default, handler, NAME, pattern, UI, Writable } from "commonfabric";\n\ninterface Input {\n  value: number | Default<0>;\n}\n\nconst increment = handler<unknown, { value: Writable<number> }>((_, state) => {\n  state.value.set(state.value.get() + 1);\n});\n\nconst decrement = handler<unknown, { value: Writable<number> }>((_, state) => {\n  state.value.set(state.value.get() - 1);\n});\n\nexport default pattern<Input>(({ value }) => {\n  return {\n    [NAME]: computed(() => `Simple counter: ${value}`),\n    [UI]: (\n      <div>\n        <cf-button onClick={decrement({ value })}>-</cf-button>\n        <b>{value}</b>\n        <cf-button onClick={increment({ value })}>+</cf-button>\n      </div>\n    ),\n    value,\n  };\n});\n'
    >;
};

const updateCode = handler<
  { detail: { value: string } },
  { code: Writable<string> }
>(
  (event, state) => {
    state.code.set(event.detail?.value ?? "");
  },
);

const visit = handler<
  unknown,
  { result: Writable<any> }
>(
  (_, { result }) => {
    console.log("visit: navigating to compiled result", result);
    return navigateTo(result);
  },
);

const handleEditContent = handler<
  { code: string },
  { code: Writable<string> }
>(
  (event, { code }) => {
    code.set(event.code);
  },
);

export default pattern<Input>(({ code }) => {
  const { result, error, errors: _ } = compileAndRun({
    files: [{ name: "/main.tsx", contents: code }],
    main: "/main.tsx",
  });

  return {
    [NAME]: "My First Compiler",
    [UI]: (
      <div>
        <cf-code-editor
          value={code}
          language="text/x.typescript"
          oncf-change={updateCode({ code })}
          //errors={errors}
        />
        {ifElse(
          error,
          <b>fix the error: {error}</b>,
          <cf-button
            onClick={visit({ result })}
          >
            Navigate To Piece
          </cf-button>,
        )}
      </div>
    ),
    code,
    updateCode: handleEditContent({ code }),
    visit: visit({ result }),
  };
});

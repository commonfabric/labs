import { Default, NAME, pattern, UI, wish } from "commonfabric";

export default pattern<Record<string, never>>((_) => {
  const { result: mentionable } = wish<Array<{ [NAME]: string }> | Default<[]>>(
    {
      query: "#mentionable",
    },
  );

  return {
    [NAME]: "Mentionable Inspector",
    [UI]: (
      <cf-vstack gap="3">
        {mentionable!.map((item) => <cf-cell-link $cell={item} />)}
      </cf-vstack>
    ),
  };
});

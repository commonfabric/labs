import { Default, NAME, pattern, resultOf, UI, wish } from "commonfabric";

export default pattern<Record<string, never>>((_) => {
  const mentionableWish = wish<
    Array<{ [NAME]: string }> | Default<[]>
  >(
    {
      query: "#mentionable",
    },
  );
  const mentionable = resultOf(mentionableWish.result);

  return {
    [NAME]: "Mentionable Inspector",
    [UI]: (
      <cf-vstack gap="3">
        {mentionable.map((item) => <cf-cell-link $cell={item} />)}
      </cf-vstack>
    ),
  };
});

import { pattern, type PerSession, type PerUser } from "commonfabric";

type ChildInput = {
  label: string;
};

type ChildOutput = {
  label: string;
};

const Child = pattern<ChildInput, ChildOutput>(({ label }) => ({ label }));

export default pattern<ChildInput>(({ label }) => {
  const userChild: PerUser<ChildOutput> = Child({ label });
  const sessionChild: PerSession<ChildOutput> = Child({ label });
  const plainChild: ChildOutput = Child({ label });

  return {
    userChild,
    sessionChild,
    plainChild,
  };
});

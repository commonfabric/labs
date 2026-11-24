import { SELF, pattern } from "commonfabric";

interface Input {
  value: string;
}

const _p = pattern<Input, Input>(({ [SELF]: self, value: _value }) => self);

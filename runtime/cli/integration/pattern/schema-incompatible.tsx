import { pattern } from "commonfabric";

interface Input {
  value: number;
}

interface Output {
  value: number | string;
}

export default pattern<Input, Output>(({ value }) => ({ value }));

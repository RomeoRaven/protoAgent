import { describe, expect, it } from "vitest";

import { tokensIn } from "./AgentRoomMode";

describe("Agent Room owner mention grammar", () => {
  it("keeps a dotted configured owner token exact", () => {
    expect(tokensIn("Hand off to @Team.Agent", ["@Team.Agent", "@all"])).toEqual(["@Team.Agent"]);
  });

  it("does not truncate an unknown @all-prefixed token into a broadcast", () => {
    expect(tokensIn("Unknown @all.foo", ["@all"])).toEqual(["@all.foo"]);
  });
});
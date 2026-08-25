import { describe, expect, it } from "vitest";

import {
  buildMemberProfile,
  getMemberAction,
  groupRoomMembers,
  insertExactMention,
  tokensIn,
} from "./AgentRoomMode";
import type { AgentRoomMember } from "../lib/types";

const member = (overrides: Partial<AgentRoomMember> = {}): AgentRoomMember => ({
  principal: "agent:researcher",
  kind: "agent",
  display_name: "Researcher",
  role: "research",
  mention_token: "@Researcher",
  host: "S1",
  can_post: true,
  can_mention: true,
  mentionable: true,
  ...overrides,
});

describe("Agent Room organization", () => {
  it("puts only mentionable agents in Wakeable agents", () => {
    const wakeable = member();
    const unconfiguredAgent = member({ principal: "agent:writer", display_name: "Writer", mentionable: false });
    const human = member({ principal: "human:owner", kind: "human", display_name: "Owner" });

    expect(groupRoomMembers([human, unconfiguredAgent, wakeable])).toEqual({
      wakeableAgents: [wakeable],
      otherMembers: [human, unconfiguredAgent],
    });
  });
});

describe("Agent Room member profiles", () => {
  it("normalizes a rich profile and derives host policy from member fields", () => {
    const profiled = member({
      can_post: false,
      can_mention: true,
      profile: {
        summary: "Finds primary sources and verifies claims.",
        capabilities: ["Web research", "Source checking"],
        best_for: ["Evidence briefs"],
        boundaries: ["Does not approve publication"],
        fallback: "Ask the room owner for editorial judgment.",
      },
    });

    expect(buildMemberProfile(profiled)).toEqual({
      purpose: "Finds primary sources and verifies claims.",
      capabilities: ["Web research", "Source checking"],
      bestFor: ["Evidence briefs"],
      boundaries: ["Does not approve publication"],
      fallback: "Ask the room owner for editorial judgment.",
      host: "S1",
      policy: ["Cannot post to the room", "Can mention room members", "Wakeable as @Researcher"],
    });
  });

  it("provides useful copy when the optional profile is absent", () => {
    expect(buildMemberProfile(member({ mentionable: false }))).toEqual({
      purpose: "Researcher serves this room in the research role.",
      capabilities: ["No capabilities listed."],
      bestFor: ["No best-fit work listed."],
      boundaries: ["No boundaries listed."],
      fallback: "No fallback guidance listed.",
      host: "S1",
      policy: ["Can post to the room", "Can mention room members", "Not wakeable from this room"],
    });
  });
});

describe("Agent Room member actions", () => {
  it("offers the exact wake action only to active wakeable agents", () => {
    expect(getMemberAction(member(), "active")).toEqual({
      canWake: true,
      label: "Wake @Researcher",
      state: "Wake as @Researcher",
    });
    expect(getMemberAction(member({ mentionable: false }), "active")).toEqual({
      canWake: false,
      label: null,
      state: "Not configured for wake-up",
    });
    expect(getMemberAction(member(), "archived")).toEqual({
      canWake: false,
      label: null,
      state: "Room archived — wake-up unavailable",
    });
  });

  it("inserts a token exactly once without posting", () => {
    expect(insertExactMention("Review this", "@Team.Agent")).toBe("Review this @Team.Agent ");
    expect(insertExactMention("@team.agent already here", "@Team.Agent")).toBe("@team.agent already here");
    expect(insertExactMention("Ping @Team.AgentExtra", "@Team.Agent")).toBe("Ping @Team.AgentExtra @Team.Agent ");
  });
});

describe("Agent Room owner mention grammar", () => {
  it("keeps a dotted configured owner token exact", () => {
    expect(tokensIn("Hand off to @Team.Agent", ["@Team.Agent", "@all"])).toEqual(["@Team.Agent"]);
  });

  it("does not truncate an unknown @all-prefixed token into a broadcast", () => {
    expect(tokensIn("Unknown @all.foo", ["@all"])).toEqual(["@all.foo"]);
  });
});
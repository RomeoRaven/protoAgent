import { describe, expect, it } from "vitest";

import type { PromptCall } from "../lib/types";
import { callTabs, fmtTok, promptNoteMarkdown, promptText, splitLine, usageLine } from "./promptView";

function mk(over: Partial<PromptCall> = {}): PromptCall {
  return {
    call_index: 0,
    ts: "2026-07-24T10:00:00+00:00",
    model: "claude-opus-4-7",
    system: { stable: "STABLE", context: "\n\n# Context\n\ntail" },
    usage: { input_tokens: 12345, output_tokens: 420, cache_read_tokens: 12000, cache_creation_tokens: 0 },
    ...over,
  };
}

describe("fmtTok", () => {
  it("uses the UsageFooter convention", () => {
    expect(fmtTok(999)).toBe("999");
    expect(fmtTok(12345)).toBe("12.3k");
    expect(fmtTok(1_200_000)).toBe("1.2M");
  });
});

describe("promptText", () => {
  it("concatenates stable + tail byte-for-byte", () => {
    expect(promptText(mk())).toBe("STABLE\n\n# Context\n\ntail");
  });
});

describe("callTabs", () => {
  it("maps calls to 1-based segmented tab items keyed by call_index", () => {
    const tabs = callTabs([mk(), mk({ call_index: 1 })]);
    expect(tabs).toEqual([
      { id: "0", label: "Call 1" },
      { id: "1", label: "Call 2" },
    ]);
  });
});

describe("usageLine", () => {
  it("renders in/out with the cache-read aside", () => {
    expect(usageLine(mk())).toBe("in 12.3k (cache read 12.0k) · out 420");
  });
  it("collapses when the call recorded no usage", () => {
    expect(
      usageLine(mk({ usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } })),
    ).toBe("");
  });
});

describe("splitLine", () => {
  it("reports where the stable/tail split lands", () => {
    const call = mk({ system: { stable: "x".repeat(1500), context: "y".repeat(20) } });
    expect(splitLine(call)).toBe("stable 1.5k chars · context tail 20 chars");
  });
});

describe("promptNoteMarkdown", () => {
  it("wraps the full text in a four-backtick fence when under the cap", () => {
    const md = promptNoteMarkdown(mk());
    expect(md).toContain("````text\nSTABLE\n\n# Context\n\ntail\n````");
    expect(md).toContain("`claude-opus-4-7`");
    expect(md).not.toContain("Showing");
  });
  it("truncates at the cap and points to the full viewer", () => {
    const call = mk({ system: { stable: "s".repeat(50), context: "" } });
    const md = promptNoteMarkdown(call, 10);
    expect(md).toContain(`\`\`\`\`text\n${"s".repeat(10)}\n\`\`\`\``);
    expect(md).toContain("Showing 10 of 50 chars");
    expect(md).toContain("**View prompt**");
  });
  it("survives prompt bodies that contain triple-backtick fences", () => {
    const call = mk({ system: { stable: "docs:\n```py\nprint()\n```", context: "" } });
    const md = promptNoteMarkdown(call);
    // The outer 4-tick fence still closes AFTER the embedded 3-tick block.
    expect(md.indexOf("````text")).toBeLessThan(md.indexOf("```py"));
    expect(md.lastIndexOf("````")).toBeGreaterThan(md.indexOf("```py"));
  });
});

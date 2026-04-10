import { describe, expect, test } from "bun:test";
import { extractOutputFromMessages } from "../src/plugin/qa";

describe("extractOutputFromMessages", () => {
  test("strips leading text content-type marker", () => {
    const result = extractOutputFromMessages([
      { role: "assistant", content: "text\nActual review content here." },
    ]);
    expect(result).toBe("Actual review content here.");
  });

  test("strips trailing OpenClaw message envelope", () => {
    const result = extractOutputFromMessages([
      {
        role: "assistant",
        content:
          'Review complete.\n{"v":1,"id":"msg_0b5aa19432cb09840169d8e4d6fcb881919ce7eb53574198eb","phase":"final_answer"}',
      },
    ]);
    expect(result).toBe("Review complete.");
  });

  test("strips both leading marker and trailing envelope", () => {
    const result = extractOutputFromMessages([
      {
        role: "assistant",
        content:
          'text\nPost-merge review complete.\n{"v":1,"id":"msg_abc123","phase":"final_answer"}',
      },
    ]);
    expect(result).toBe("Post-merge review complete.");
  });

  test("preserves clean output without framing", () => {
    const result = extractOutputFromMessages([
      { role: "assistant", content: "Clean output with no framing." },
    ]);
    expect(result).toBe("Clean output with no framing.");
  });

  test("returns empty string for no messages", () => {
    expect(extractOutputFromMessages([])).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { logger, loggerStorage } from "./logger.ts";

describe("session diagnostics", () => {
  it("stores summaries without caller values or URL credentials", () => {
    const sentinel = "SENSITIVE_LOG_SENTINEL";
    const input = {
      msg: `request https://user:${sentinel}@tracker.example/path/${sentinel}?token=${sentinel} Bearer ${sentinel}`,
      data: { freeText: sentinel, nested: { password: sentinel } },
    };
    logger(input);
    const written = loggerStorage.value.at(-1)!;
    expect(JSON.stringify(written)).not.toContain(sentinel);
    expect(written.data).toEqual({ type: "object", count: 2 });
    expect(input.data.freeText).toBe(sentinel);
  });
});

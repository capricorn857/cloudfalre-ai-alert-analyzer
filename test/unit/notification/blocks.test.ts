import { describe, expect, it } from "vitest";
import { assembleBlocks } from "../../../src/notification/blocks";

describe("complete notification block budgets", () => {
  it.each([1999, 2000])("accepts a complete required block of %i UTF-8 bytes", (length) => {
    const required = "界".repeat(Math.floor(length / 3)) + "a".repeat(length % 3);
    const output = assembleBlocks([{ required, optional: [] }], 3500);
    expect(new TextEncoder().encode(output).byteLength).toBe(length);
    expect(output).toBe(required);
  });
  it("rejects a required block over 2000 bytes rather than truncating it", () => {
    expect(() => assembleBlocks([{ required: "a".repeat(2001), optional: [] }], 3500)).toThrow();
  });
  it("keeps optional blocks complete and preserves ranking after redistributing spare capacity", () => {
    const first = "Top 1: " + "x".repeat(80);
    const second = "Top 2: short";
    const output = assembleBlocks([
      { required: "Host: a", optional: [first, second] },
      { required: "Host: b", optional: ["IP: small"] },
    ], 180);
    expect(output).toContain(first);
    expect(output.indexOf(first)).toBeLessThan(output.indexOf(second));
    expect(output).toContain("IP: small");
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(180);
  });
});

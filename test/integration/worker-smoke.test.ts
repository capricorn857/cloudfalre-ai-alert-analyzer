import { describe, expect, it } from "vitest";

import worker from "../../src/index";

describe("module worker", () => {
  it("exports fetch and queue handlers", () => {
    expect(worker.fetch).toBeTypeOf("function");
    expect(worker.queue).toBeTypeOf("function");
  });
});

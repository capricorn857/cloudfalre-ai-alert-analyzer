import { readFileSync } from "node:fs";
import { log as print } from "node:console";
import { parseEnv } from "node:util";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { z } from "zod";

let localEnv;
try {
  localEnv = parseEnv(readFileSync(".env", "utf8"));
} catch {
  throw new Error("live_llm_env_unreadable");
}
const parsed = z.object({
  LLM_BASE_URL: z.url(),
  LLM_MODEL: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
}).safeParse(localEnv);
if (!parsed.success) throw new Error("live_llm_config_invalid");

export default defineConfig({
  plugins: [cloudflareTest({
    remoteBindings: false,
    miniflare: {
      compatibilityDate: "2026-09-16",
      compatibilityFlags: ["nodejs_compat"],
      bindings: parsed.data,
    },
  })],
  test: {
    include: ["test/live/llm-provider.live.ts"],
    maxWorkers: 1,
    testTimeout: 120_000,
    retry: 0,
    reporters: ["default", {
      onTestCaseResult(testCase) {
        const reports = testCase.meta().liveLlmReports;
        if (!Array.isArray(reports)) return;
        for (const report of reports) if (typeof report === "string") print(report);
      },
    }],
  },
});

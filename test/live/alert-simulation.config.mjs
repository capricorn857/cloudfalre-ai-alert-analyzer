import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { log as print } from "node:console";
import process from "node:process";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { z } from "zod";

let localEnv;
let business;
try {
  localEnv = parseEnv(readFileSync(".env", "utf8"));
  business = JSON.parse(readFileSync("wrangler.jsonc", "utf8")).vars.BUSINESS_CONFIG;
} catch { throw new Error("live_simulation_configuration_unreadable"); }
const send = process.env.LIVE_SEND_WECOM === "true";
const parsed = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1), LLM_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.url(), LLM_MODEL: z.string().min(1),
  ...(send ? { WECOM_WEBHOOK_URL: z.url() } : {}),
}).safeParse(localEnv);
if (!parsed.success) throw new Error("live_simulation_credentials_invalid");
const target = z.object({ zone: z.string().min(1), alertTime: z.iso.datetime({ offset: true }) })
  .safeParse({ zone: process.env.LIVE_ZONE_NAME, alertTime: process.env.LIVE_ALERT_TIME });
if (!target.success) throw new Error("live_simulation_target_required");
const directory = mkdtempSync(join(tmpdir(), "host-alert-simulation-"));
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

export default defineConfig({
  plugins: [cloudflareTest({ remoteBindings: false, miniflare: {
    compatibilityDate: "2026-09-16", compatibilityFlags: ["nodejs_compat"],
    bindings: { ...parsed.data, LIVE_ZONE_NAME: target.data.zone, LIVE_ALERT_TIME: target.data.alertTime,
      LIVE_SEND_WECOM: send, BUSINESS_CONFIG: business },
  } })],
  test: {
    include: ["test/live/alert-simulation.live.ts"], maxWorkers: 1, retry: 0, testTimeout: 180_000,
    reporters: ["default", { onTestCaseResult(testCase) {
      const { simulationReports, notificationPreview } = testCase.meta();
      if (Array.isArray(simulationReports)) {
        const lines = simulationReports.filter((line) => typeof line === "string");
        writeFileSync(join(directory, "diagnostics.jsonl"), lines.join("\n") + "\n", { mode: 0o600 });
        for (const line of lines) print(line);
      }
      if (typeof notificationPreview === "string") {
        writeFileSync(join(directory, "notification.txt"), notificationPreview, { mode: 0o600 });
      }
      print(JSON.stringify({ event: "live_simulation_artifacts", directory }));
    } }],
  },
});

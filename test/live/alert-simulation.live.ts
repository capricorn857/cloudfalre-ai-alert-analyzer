import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { z } from "zod";
import { BusinessConfigSchema } from "../../src/config/env";
import { CloudflareGraphQLClient } from "../../src/clients/cloudflare-graphql";
import { LLMClient } from "../../src/clients/llm";
import { WeComClient } from "../../src/clients/wecom";
import { buildQueueMessage } from "../../src/pipeline/window";
import { processHostAlert } from "../../src/pipeline/process-alert";
import { createLogger } from "../../src/observability/logger";

it("simulates one historical alert with real collection and AI", async (context) => {
  const parsed = z.object({
    CLOUDFLARE_API_TOKEN: z.string().min(1), LLM_API_KEY: z.string().min(1),
    LLM_BASE_URL: z.url(), LLM_MODEL: z.string().min(1), WECOM_WEBHOOK_URL: z.url().optional(),
    LIVE_ZONE_NAME: z.string().min(1), LIVE_ALERT_TIME: z.iso.datetime({ offset: true }),
    LIVE_SEND_WECOM: z.boolean(), BUSINESS_CONFIG: BusinessConfigSchema,
  }).safeParse(env);
  if (!parsed.success) throw new Error("live_simulation_bindings_invalid");
  const config = parsed.data;
  const business = config.BUSINESS_CONFIG;
  const meta = Object.assign(context.task.meta, { simulationReports: [] as string[], notificationPreview: "" });
  const logger = createLogger({ secrets: [config.CLOUDFLARE_API_TOKEN, config.LLM_API_KEY,
    config.LLM_BASE_URL, config.WECOM_WEBHOOK_URL ?? ""], sink: (line) => meta.simulationReports.push(line) });
  const zoneUrl = new URL("https://api.cloudflare.com/client/v4/zones");
  zoneUrl.searchParams.set("name", config.LIVE_ZONE_NAME);
  zoneUrl.searchParams.set("per_page", "2");
  const response = await fetch(zoneUrl, { headers: { Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}` },
    redirect: "manual", signal: AbortSignal.timeout(business.requestTimeoutMs) });
  const zone = z.object({ success: z.literal(true), result: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{32}$/u), name: z.string() })).length(1) })
    .safeParse(await response.json());
  if (!response.ok || !zone.success || zone.data.result[0]?.name !== config.LIVE_ZONE_NAME) {
    logger.error("live_zone_resolution_failed", { http_status: response.status });
    throw new Error("live_zone_resolution_failed");
  }
  const zoneId = zone.data.result[0].id;
  const id = `simulation-${crypto.randomUUID()}`;
  const message = buildQueueMessage({ name: "local historical simulation",
    data: { alert_start_time: config.LIVE_ALERT_TIME, zone_name: config.LIVE_ZONE_NAME, zone_tag: zoneId, events_count: 0 },
    alert_type: "clickhouse_alert_fw_anomaly", alert_event: "ALERT_STATE_EVENT_START", alert_correlation_id: id,
  }, business, new Date(config.LIVE_ALERT_TIME));
  logger.info("live_simulation_started", { analysis_window: message.analysisWindow,
    received_time_assumed_equal_alert_time: true, payload_count_placeholder: true,
    host_limit: business.hostLimit, sample_limit: business.sampleLimit, notification_mode: config.LIVE_SEND_WECOM ? "send" : "preview" });

  let graphqlRequests = 0;
  let llmRequests = 0;
  const cloudflare = new CloudflareGraphQLClient({ token: config.CLOUDFLARE_API_TOKEN,
    timeoutMs: business.requestTimeoutMs, retries: business.retryCount,
    fetchFn: async (input, init) => {
      if (input !== "https://api.cloudflare.com/client/v4/graphql" || typeof init?.body !== "string") throw new Error("unexpected_graphql_request");
      const body = z.object({ variables: z.object({ zoneTag: z.string(), start: z.string(), end: z.string() }) }).safeParse(JSON.parse(init.body) as unknown);
      if (!body.success || body.data.variables.zoneTag !== zoneId || body.data.variables.start !== message.analysisWindow.start || body.data.variables.end !== message.analysisWindow.end) throw new Error("live_fixed_window_mismatch");
      graphqlRequests++;
      return fetch(input, { ...init, redirect: "manual" });
    },
  });
  const endpoint = `${config.LLM_BASE_URL.replace(/\/$/u, "")}/chat/completions`;
  const llm = new LLMClient({ baseUrl: config.LLM_BASE_URL, model: config.LLM_MODEL, apiKey: config.LLM_API_KEY,
    timeoutMs: business.llmTimeoutMs, maxOutputTokens: business.llmMaxOutputTokens,
    fetchFn: async (input, init) => {
      if (input !== endpoint) throw new Error("unexpected_llm_request");
      llmRequests++;
      return fetch(input, { ...init, redirect: "manual" });
    },
  });
  const marker = "【历史告警模拟测试】\n";
  let notificationCalls = 0;
  let analyzedEvents = 0;
  const result = await processHostAlert(message, {
    cloudflare: {
      discoverZone: async (input) => {
        const discovery = await cloudflare.discoverZone(input);
        logger.info("live_zone_discovered", { zone_total_events: discovery.zoneTotalEvents, returned_host_rows: discovery.topHosts.length });
        return discovery;
      },
      collectHostSnapshot: async (input, selected) => {
        const collection = await cloudflare.collectHostSnapshot(input, selected);
        if (collection.hostTotalEvents !== null) analyzedEvents += collection.hostTotalEvents;
        logger.info("live_host_collected", { host_id: collection.hostId,
          discovery_count: collection.discoveryCount, host_total_events: collection.hostTotalEvents,
          sample_count: collection.samples.length, collection_status: collection.collectionStatus,
          samples_status: collection.samplesStatus });
        return collection;
      },
    },
    ai: { analyzeHosts: async (catalog) => {
      logger.info("live_ai_input", { host_count: catalog.hostIds.length, catalog_bytes: new TextEncoder().encode(JSON.stringify(catalog)).byteLength });
      return llm.analyzeHosts(catalog);
    } },
    notification: { send: async (text) => {
      notificationCalls++;
      const preview = marker + text;
      if (new TextEncoder().encode(preview).byteLength > 2000) throw new Error("live_notification_budget_exceeded");
      meta.notificationPreview = preview;
      if (config.LIVE_SEND_WECOM) {
        if (config.WECOM_WEBHOOK_URL === undefined) throw new Error("live_notification_url_missing");
        await new WeComClient({ webhookUrl: config.WECOM_WEBHOOK_URL, timeoutMs: business.requestTimeoutMs, retries: business.retryCount }).send(preview);
      }
      logger.info("live_notification_result", { mode: config.LIVE_SEND_WECOM ? "sent" : "preview",
        utf8_bytes: new TextEncoder().encode(preview).byteLength });
    } },
    logger: { ...logger, info: (event, fields) => {
      if (!config.LIVE_SEND_WECOM && event === "notification_sent") {
        logger.info("live_notification_preview_completed", { ...fields, wecom_status: "not_called" });
      } else logger.info(event, fields);
    } }, rulesConfig: business.rules,
    formatterOptions: { timeZone: business.displayTimeZone, maxLength: 2000 - new TextEncoder().encode(marker).byteLength, topLimit: 3 },
  });
  logger.info("live_simulation_result", { ...result, notification_mode: config.LIVE_SEND_WECOM ? "real" : "preview", graphql_requests: graphqlRequests,
    llm_requests: llmRequests, notification_calls: notificationCalls, analyzed_events: analyzedEvents,
    real_wecom_enabled: config.LIVE_SEND_WECOM });
  expect(result.status, "See controlled simulation diagnostics").toBe("sent");
  expect(notificationCalls).toBe(1);
  expect(analyzedEvents, "Historical window must contain analyzable events").toBeGreaterThan(0);
  expect(result.snapshotStatus, "See collection diagnostics").toBe("success");
  expect(result.aiStatus, "See per Host AI diagnostics").toBe("available");
});

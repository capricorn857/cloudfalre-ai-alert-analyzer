import { parseEnv } from "../config/env";
import type { Clock } from "../clients/contracts";
import { CloudflareAlertPayloadSchema } from "../domain/alert";
import { mapCloudflareAlert } from "../pipeline/dispatcher";
import { buildQueueMessage } from "../pipeline/window";

const CLOUDFLARE_ALERT_PATH = "/api/v1/alerts/cloudflare";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024;

export interface AlertHandlerDependencies {
  readonly clock?: Clock;
  readonly maxRequestBodyBytes?: number;
}

const systemClock: Clock = { now: () => new Date() };

function response(status: number, body: string): Response {
  return new Response(JSON.stringify({ message: body }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleCloudflareAlert(
  request: Request,
  envInput: unknown,
  dependencies: AlertHandlerDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== CLOUDFLARE_ALERT_PATH) return response(404, "Not Found");
  if (request.method !== "POST") return response(405, "Method Not Allowed");

  const maximumBytes = dependencies.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return response(413, "Payload Too Large");
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBytes) {
    return response(413, "Payload Too Large");
  }

  let unknownPayload: unknown;
  try {
    unknownPayload = JSON.parse(body) as unknown;
  } catch {
    return response(400, "Invalid JSON");
  }

  const payloadResult = CloudflareAlertPayloadSchema.safeParse(unknownPayload);
  if (!payloadResult.success) return response(400, "Invalid Cloudflare alert payload");
  if (mapCloudflareAlert(payloadResult.data) === null) {
    return response(202, "Unsupported alert type ignored");
  }

  const env = parseEnv(envInput);
  const message = buildQueueMessage(
    payloadResult.data,
    {
      beforeMinutes: env.business.beforeMinutes,
      settleSeconds: env.business.settleSeconds,
      sampleLimit: env.business.sampleLimit,
    },
    (dependencies.clock ?? systemClock).now(),
  );

  try {
    await env.alertQueue.send(message, { delaySeconds: env.business.settleSeconds });
  } catch {
    return response(503, "Queue unavailable");
  }

  return response(202, "Accepted");
}

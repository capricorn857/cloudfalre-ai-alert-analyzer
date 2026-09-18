import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudflareGraphQLClient } from "../../src/clients/cloudflare-graphql";
import { AppError } from "../../src/observability/errors";
import aggregateSuccess from "../fixtures/graphql/aggregate-success.json";
import emptySuccess from "../fixtures/graphql/empty-success.json";
import graphqlErrors from "../fixtures/graphql/errors.json";
import samplesSuccess from "../fixtures/graphql/samples-success.json";

const input = {
  zoneTag: "zone-test",
  analysisWindow: {
    start: "2026-09-14T08:48:46.000Z",
    end: "2026-09-14T09:20:00.000Z",
  },
  sampleLimit: 50,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyAsString(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") throw new Error("Expected a string request body");
  return body;
}

describe("CloudflareGraphQLClient", () => {
  it("calls the default Workers fetch without an invalid receiver", async () => {
    let requestCount = 0;
    const runtimeFetch = vi.fn(function (this: unknown): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation: function called with incorrect this reference");
      }
      requestCount += 1;
      return Promise.resolve(
        jsonResponse(requestCount === 1 ? aggregateSuccess : samplesSuccess),
      );
    });
    vi.stubGlobal("fetch", runtimeFetch);
    const client = new CloudflareGraphQLClient({
      token: "cf-test-secret",
      timeoutMs: 1000,
      retries: 0,
    });

    await expect(client.collectSnapshot(input)).resolves.toMatchObject({ totalEvents: 400 });
    expect(runtimeFetch).toHaveBeenCalledTimes(2);
  });

  it("collects aggregates and samples with one immutable window", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(aggregateSuccess))
      .mockResolvedValueOnce(jsonResponse(samplesSuccess));
    const client = new CloudflareGraphQLClient({
      token: "cf-test-secret",
      fetchFn,
      timeoutMs: 1000,
      retries: 1,
    });

    const snapshot = await client.collectSnapshot(input);

    expect(snapshot.totalEvents).toBe(400);
    expect(snapshot.topIps[0]).toEqual({ value: "192.0.2.10", count: 220 });
    expect(snapshot.samples).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const call of fetchFn.mock.calls) {
      const request = call[1];
      expect(new Headers(request?.headers).get("authorization")).toBe("Bearer cf-test-secret");
      const body = JSON.parse(bodyAsString(request?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      expect(body.query).toContain("$zoneTag: String!");
      expect(body.variables).toMatchObject({
        zoneTag: "zone-test",
        start: input.analysisWindow.start,
        end: input.analysisWindow.end,
      });
    }
  });

  it("does not start another collection round for an empty snapshot", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(emptySuccess))
      .mockResolvedValueOnce(jsonResponse({ data: { viewer: { zones: [{ samples: [] }] } } }));
    const client = new CloudflareGraphQLClient({
      token: "cf-test-secret",
      fetchFn,
      timeoutMs: 1000,
      retries: 1,
    });

    await expect(client.collectSnapshot(input)).resolves.toMatchObject({ totalEvents: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries 429 with identical variables and stops after success", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(aggregateSuccess))
      .mockResolvedValueOnce(jsonResponse(samplesSuccess));
    const client = new CloudflareGraphQLClient({
      token: "cf-test-secret",
      fetchFn,
      timeoutMs: 1000,
      retries: 1,
      sleep: () => Promise.resolve(),
    });

    await client.collectSnapshot(input);

    const firstBody = bodyAsString(fetchFn.mock.calls[0]?.[1]?.body);
    const retryBody = bodyAsString(fetchFn.mock.calls[1]?.[1]?.body);
    expect(retryBody).toBe(firstBody);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent HTTP, GraphQL, or schema errors", async () => {
    for (const response of [
      jsonResponse({}, 401),
      jsonResponse(graphqlErrors),
      jsonResponse({ data: { viewer: {} } }),
    ]) {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
      const client = new CloudflareGraphQLClient({
        token: "cf-test-secret",
        fetchFn,
        timeoutMs: 1000,
        retries: 2,
        sleep: () => Promise.resolve(),
      });

      await expect(client.collectSnapshot(input)).rejects.toBeDefined();
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  });

  it("attaches stable fields to HTTP and network failures", async () => {
    const cases = [
      {
        fetchFn: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401)),
        expected: { failureKind: "http", httpStatus: 401, retryable: false },
      },
      {
        fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")),
        expected: { failureKind: "network", retryable: true },
      },
    ];

    for (const testCase of cases) {
      const client = new CloudflareGraphQLClient({
        token: "cf-test-secret",
        fetchFn: testCase.fetchFn,
        timeoutMs: 1000,
        retries: 0,
      });

      const error = await client.collectSnapshot(input).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        externalService: "cloudflare",
        ...testCase.expected,
      });
      expect((error as AppError).durationMs).toEqual(expect.any(Number));
    }
  });

  it("classifies GraphQL errors as a service failure without preserving raw errors", async () => {
    const client = new CloudflareGraphQLClient({
      token: "cf-test-secret",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(graphqlErrors)),
      timeoutMs: 1000,
      retries: 0,
    });

    const error = await client.collectSnapshot(input).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "cloudflare_graphql_errors",
      externalService: "cloudflare",
      failureKind: "service_error",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("query failed");
  });
});

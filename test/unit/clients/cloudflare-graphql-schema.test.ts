import { describe, expect, it } from "vitest";

import {
  AggregateGraphQLResponseSchema,
  SamplesGraphQLResponseSchema,
  parseGraphQLData,
} from "../../../src/clients/cloudflare-graphql-schema";
import aggregateSuccess from "../../fixtures/graphql/aggregate-success.json";
import emptySuccess from "../../fixtures/graphql/empty-success.json";
import graphqlErrors from "../../fixtures/graphql/errors.json";
import samplesSuccess from "../../fixtures/graphql/samples-success.json";

describe("Cloudflare GraphQL response schemas", () => {
  it("accepts aggregate, sample, and empty snapshots", () => {
    expect(AggregateGraphQLResponseSchema.parse(aggregateSuccess).data.viewer.zones[0]?.total[0]?.count).toBe(
      400,
    );
    expect(AggregateGraphQLResponseSchema.parse(emptySuccess).data.viewer.zones[0]?.total[0]?.count).toBe(0);
    expect(SamplesGraphQLResponseSchema.parse(samplesSuccess).data.viewer.zones[0]?.samples).toHaveLength(1);
  });

  it("rejects HTTP 200 responses containing GraphQL errors", () => {
    expect(() => parseGraphQLData(AggregateGraphQLResponseSchema, graphqlErrors)).toThrow(
      /cloudflare_graphql_errors/u,
    );
  });

  it("rejects malformed response shapes", () => {
    expect(() => parseGraphQLData(AggregateGraphQLResponseSchema, { data: { viewer: {} } })).toThrow(
      /cloudflare_response_invalid/u,
    );
  });
});

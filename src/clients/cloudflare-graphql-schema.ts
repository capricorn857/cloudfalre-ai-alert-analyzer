import { z } from "zod";

import { AppError } from "../observability/errors";

const CountSchema = z.number().int().nonnegative();
const group = <T extends z.ZodRawShape>(dimensions: T) =>
  z.object({ count: CountSchema, dimensions: z.object(dimensions) });

const AggregateZoneSchema = z.object({
  total: z.array(z.object({ count: CountSchema })).min(1),
  topIps: z.array(group({ clientIP: z.string().min(1) })),
  topPaths: z.array(group({ clientRequestPath: z.string().min(1) })),
  topHosts: z.array(group({ clientRequestHTTPHost: z.string().min(1) })),
  topCountries: z.array(group({ clientCountryName: z.string().min(1) })),
  topAsns: z.array(group({ clientAsn: z.union([z.number().int().nonnegative(), z.string().min(1)]) })),
  actions: z.array(group({ action: z.string().min(1) })),
  sources: z.array(group({ source: z.string().min(1) })),
});

export const AggregateGraphQLResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      zones: z.array(AggregateZoneSchema).min(1),
    }),
  }),
});

const SampleSchema = z.object({
  datetime: z.iso.datetime({ offset: true }),
  action: z.string().min(1),
  clientIP: z.string().min(1),
  clientCountryName: z.string().min(1).nullable().optional(),
  clientAsn: z.union([z.number().int().nonnegative(), z.string().min(1)]).nullable().optional(),
  clientRequestHTTPHost: z.string().min(1).nullable().optional(),
  clientRequestPath: z.string().min(1).nullable().optional(),
  source: z.string().min(1).nullable().optional(),
  userAgent: z.string().min(1).nullable().optional(),
});

export const SamplesGraphQLResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      zones: z.array(z.object({ samples: z.array(SampleSchema) })).min(1),
    }),
  }),
});

const GraphQLErrorEnvelopeSchema = z.object({
  errors: z.array(z.object({ message: z.string() })).min(1),
});

export function parseGraphQLData<T extends z.ZodType>(
  schema: T,
  input: unknown,
  durationMs = 0,
): z.output<T> {
  if (GraphQLErrorEnvelopeSchema.safeParse(input).success) {
    throw new AppError("cloudflare_graphql_errors", "cloudflare_graphql_errors", false, undefined, {
      externalService: "cloudflare",
      failureKind: "service_error",
      durationMs,
    });
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError("cloudflare_response_invalid", "cloudflare_response_invalid", false, undefined, {
      externalService: "cloudflare",
      failureKind: "invalid_response",
      durationMs,
    });
  }
  return result.data;
}

export type AggregateGraphQLResponse = z.infer<typeof AggregateGraphQLResponseSchema>;
export type SamplesGraphQLResponse = z.infer<typeof SamplesGraphQLResponseSchema>;

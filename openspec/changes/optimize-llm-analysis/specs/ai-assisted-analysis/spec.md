# AI 辅助分析优化规范

## ADDED Requirements

### Requirement: LLM output diagnostics and validation
The LLM client MUST classify response failures without retaining the model content or prompt.

#### Scenario: truncated completion
- **WHEN** a successful completion has `finish_reason` equal to `length`
- **THEN** the client returns `llm_output_truncated`, records `finish_reason`, `content_length`, token usage when safe, and does not parse or send the content onward

#### Scenario: refusal
- **WHEN** `message.refusal` is present
- **THEN** the client returns `llm_refused` with `refusal_present=true` and no refusal text

#### Scenario: non-JSON content
- **WHEN** content is not valid JSON, including Markdown-wrapped JSON
- **THEN** the client returns `llm_output_not_json` with `validation_stage=parsing`

#### Scenario: schema-invalid JSON
- **WHEN** JSON parses but fails the LLM output Zod schema
- **THEN** the client returns `llm_output_schema_invalid` with `validation_stage=schema` and only safe `schema_issue_paths`

#### Scenario: invalid evidence
- **WHEN** the parsed AI result fails Evidence validation
- **THEN** the client returns `ai_evidence_invalid` with `validation_stage=evidence` and no relaxed validation

### Requirement: configurable output token budget
The business configuration MUST expose `llmMaxOutputTokens` as an integer from 512 through 8192, defaulting to 2048, and the LLM request MUST use it as `max_completion_tokens`.

#### Scenario: default and override
- **WHEN** the property is omitted or set to a valid boundary/interior integer
- **THEN** configuration resolves to 2048 or the explicit value respectively

#### Scenario: invalid token budget
- **WHEN** the property is below 512, above 8192, fractional, or non-numeric
- **THEN** configuration fails without exposing secret values

### Requirement: bounded transient LLM retry
The LLM client MUST retry only HTTP 429 and HTTP 500 or greater at most once, with a short bounded delay.

#### Scenario: transient HTTP failure
- **WHEN** the first LLM request returns 429 or 5xx
- **THEN** the client performs at most one retry, reports total duration and final status, and never repeats upstream analysis or notification

#### Scenario: permanent or output failure
- **WHEN** the response is 400/401/403 or any output/Evidence validation fails
- **THEN** the client does not retry and the pipeline uses the existing rules fallback

### Requirement: model compatibility verification
Model compatibility MUST be evaluated outside the production pipeline using the configured Router `/models` endpoint and a fixed sanitized input.

#### Scenario: recommendation gate
- **WHEN** comparing available models
- **THEN** the record includes HTTP status, time-to-first-byte, total duration, finish reason, JSON/schema/Evidence success rates, and recommends only models supporting `/chat/completions`, `response_format=json_schema`, `strict=true`, stable structured output, and latency below the current `gpt-5.5` baseline

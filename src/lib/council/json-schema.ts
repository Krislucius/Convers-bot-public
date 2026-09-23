export type SchemaIssue = { path: string; message: string };

export const SYNTHESIS_STATUS = [
  "APPROVED",
  "READY_FOR_REVIEW",
  "PATCH",
  "BLOCKED",
  "USER_DECISION_REQUIRED",
] as const;

const THINK_BLOCKS =
  /<(?:think|thinking|thought|reasoning)[^>]*>[\s\S]*?<\/(?:think|thinking|thought|reasoning)>/gi;
const THINK_PIPE = /<\|(?:think|thinking|reason)[^|]*>[\s\S]*?<\|\/(?:think|thinking|reason)\|>/gi;
const THINK_FENCE = /```(?:thinking|reasoning|thought)[\s\S]*?```/gi;

export function stripReasoning(text: string): string {
  return String(text ?? "")
    .replace(THINK_BLOCKS, "\n")
    .replace(THINK_PIPE, "\n")
    .replace(THINK_FENCE, "\n");
}

export function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function extractBalancedObjects(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

export function extractJsonCandidates(text: string): string[] {
  const cleaned = stripReasoning(text);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string) => {
    const next = value.trim();
    if (!next.startsWith("{") || seen.has(next)) return;
    seen.add(next);
    out.push(next);
  };
  for (const fence of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    for (const obj of extractBalancedObjects(fence[1] ?? "")) push(obj);
  }
  const objects = extractBalancedObjects(cleaned);
  for (let i = objects.length - 1; i >= 0; i -= 1) push(objects[i]!);
  if (cleaned.trim().startsWith("{")) push(cleaned.trim());
  return out;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  for (const candidate of [raw, stripTrailingCommas(raw)]) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      /* next */
    }
  }
  return null;
}

function scoreSynthObject(value: Record<string, unknown>): number {
  let score = 1;
  if (value.status) score += 6;
  if (value.artifact) score += 4;
  if (value.recommendation) score += 1;
  if (value.agent_positions || value.agentPositions) score += 2;
  if (value.review_verdict || value.reviewVerdict) score += 2;
  if (value.decision) score += 2;
  if (value.operator_record || value.operatorRecord) score += 3;
  return score;
}

export function extractJsonValue(text: string): { value: Record<string, unknown> | null; error: string | null } {
  const candidates = extractJsonCandidates(text);
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const raw of candidates) {
    const parsed = tryParseObject(raw);
    if (!parsed) continue;
    const score = scoreSynthObject(parsed);
    if (score > bestScore) {
      best = parsed;
      bestScore = score;
    }
  }
  if (best) return { value: best, error: null };
  const cleaned = stripReasoning(text).trim();
  if (!cleaned) return { value: null, error: "empty response" };
  if (cleaned.includes("{") && !cleaned.includes("}")) return { value: null, error: "JSON truncated" };
  return { value: null, error: "not valid JSON" };
}

export function jsonSchemaFromResponseFormat(
  responseFormat: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!responseFormat || typeof responseFormat !== "object") return null;
  const wrapped = responseFormat.json_schema as { schema?: Record<string, unknown> } | undefined;
  if (wrapped?.schema && typeof wrapped.schema === "object") return wrapped.schema;
  if (responseFormat.type === "object" && responseFormat.properties) return responseFormat;
  return null;
}

function joinPath(base: string, key: string): string {
  return base ? `${base}/${key}` : `/${key}`;
}

export function collectSchemaIssues(
  value: unknown,
  schema: Record<string, unknown> | null | undefined,
  path = "",
): SchemaIssue[] {
  if (!schema) return [];
  const issues: SchemaIssue[] = [];
  const expectedType = schema.type;
  if (expectedType === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ path: path || "/", message: "expected object" });
      return issues;
    }
    const rec = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (rec[key] === undefined) issues.push({ path: joinPath(path, key), message: "required" });
    }
    for (const [key, spec] of Object.entries(properties)) {
      if (rec[key] === undefined) continue;
      issues.push(...collectSchemaIssues(rec[key], spec, joinPath(path, key)));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(rec)) {
        if (!(key in properties)) issues.push({ path: joinPath(path, key), message: "additional property not allowed" });
      }
    }
    return issues;
  }
  if (expectedType === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path: path || "/", message: "expected array" });
      return issues;
    }
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    if (itemSchema) {
      value.forEach((item, index) => {
        issues.push(...collectSchemaIssues(item, itemSchema, `${path || ""}/${index}`));
      });
    }
    return issues;
  }
  if (expectedType === "string") {
    if (typeof value !== "string") issues.push({ path: path || "/", message: "expected string" });
    else if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      issues.push({ path: path || "/", message: `expected one of ${(schema.enum as string[]).join("|")}` });
    }
    return issues;
  }
  if (expectedType === "number" || expectedType === "integer") {
    if (typeof value !== "number" || (expectedType === "integer" && !Number.isInteger(value))) {
      issues.push({ path: path || "/", message: `expected ${expectedType}` });
    }
    return issues;
  }
  if (expectedType === "boolean" && typeof value !== "boolean") {
    issues.push({ path: path || "/", message: "expected boolean" });
  }
  return issues;
}

export function acceptSynthesisJson(value: unknown, mode: string): SchemaIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ path: "/", message: "expected a JSON object" }];
  }
  const rec = value as Record<string, unknown>;
  const issues: SchemaIssue[] = [];
  const status = String(rec.status ?? "").toUpperCase().replace(/\s+/g, "_");
  if (!String(rec.status ?? "").trim()) issues.push({ path: "/status", message: "required" });
  else if (status !== "PASS" && !SYNTHESIS_STATUS.includes(status as (typeof SYNTHESIS_STATUS)[number])) {
    issues.push({ path: "/status", message: `expected one of ${SYNTHESIS_STATUS.join("|")}` });
  }
  if (mode === "CREATE") {
    const artifact = rec.artifact;
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      issues.push({ path: "/artifact", message: "required object with title and content" });
    } else {
      const art = artifact as Record<string, unknown>;
      if (!String(art.title ?? "").trim()) issues.push({ path: "/artifact/title", message: "required non-empty string" });
      const content = String(art.content ?? art.body ?? art.markdown ?? "").trim();
      if (!content) issues.push({ path: "/artifact/content", message: "required non-empty string" });
    }
  }
  const record = rec.operator_record ?? rec.operatorRecord;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    issues.push({ path: "/operator_record", message: "required object with summary" });
  } else {
    const summary = String((record as Record<string, unknown>).summary ?? "").trim();
    if (!summary) issues.push({ path: "/operator_record/summary", message: "required non-empty string" });
  }
  return issues;
}

export function inspectSynthesis(
  text: string,
  mode: string,
  responseFormat?: Record<string, unknown> | null,
): { ok: boolean; value: Record<string, unknown> | null; issues: SchemaIssue[] } {
  const extracted = extractJsonValue(text);
  if (!extracted.value) {
    return { ok: false, value: null, issues: [{ path: "/", message: extracted.error ?? "not valid JSON" }] };
  }
  const issues = acceptSynthesisJson(extracted.value, mode);
  if (issues.length) {
    const schemaIssues = collectSchemaIssues(extracted.value, jsonSchemaFromResponseFormat(responseFormat ?? null)).filter(
      (issue) => issue.message !== "additional property not allowed",
    );
    const seen = new Set(issues.map((row) => `${row.path}:${row.message}`));
    for (const extra of schemaIssues) {
      const key = `${extra.path}:${extra.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(extra);
    }
  }
  return { ok: issues.length === 0, value: extracted.value, issues };
}

export function formatSchemaIssues(issues: SchemaIssue[]): string {
  return issues.map((row) => `${row.path || "/"}: ${row.message}`).join("; ");
}

export function invalidSynthesisMessage(issues: SchemaIssue[]): string {
  const details = formatSchemaIssues(issues);
  if (!details) return "Synthesis failed: invalid synthesis response.";
  return `Synthesis failed: JSON schema invalid — ${details}`;
}

export function synthesisRepairPrompt(issues: SchemaIssue[], schemaName = "council_result"): string {
  const lines = (issues.length ? issues : [{ path: "/", message: "not valid JSON" }])
    .slice(0, 12)
    .map((row) => `- ${row.path || "/"}: ${row.message}`)
    .join("\n");
  return `Your previous reply failed ${schemaName} JSON Schema validation.
Errors:
${lines}
Reply with one JSON object only. No markdown fences. No thinking. No preamble.`;
}

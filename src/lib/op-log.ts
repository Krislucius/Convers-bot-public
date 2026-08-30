import type { AccessCheckResult } from "./history/types.ts";

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatOpLog(op: string, payload: Record<string, unknown>, ok = true): string {
  return prettyJson({
    title: "Conversation Bot · operation log",
    op,
    result: ok ? "OK" : "FAIL",
    time: new Date().toISOString(),
    ...payload,
  });
}

export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack ?? null,
    };
  }
  return { error_message: String(error) };
}

export function formatExceptionLog(op: string, error: unknown, extra: Record<string, unknown> = {}): string {
  return formatOpLog(op, { ...errorFields(error), ...extra }, false);
}

export function formatAccessOpLog(op: string, access: AccessCheckResult, extra: Record<string, unknown> = {}): string {
  return formatOpLog(
    op,
    {
      accessStatus: access.accessStatus,
      provider: access.provider,
      requestedUrl: access.requestedUrl,
      finalUrl: access.finalUrl,
      httpStatus: access.httpStatus,
      titleHint: access.titleHint,
      importAllowed: access.importAllowed,
      detectedShare: access.detectedShare,
      fetchedBytes: access.fetchedBytes ?? null,
      truncated: access.truncated ?? false,
      lastError: access.lastError,
      message: access.message,
      ...extra,
    },
    access.accessStatus === "ACCESSIBLE",
  );
}

export function formatImportOpLog(input: {
  op: "import_url" | "reimport_url" | "reimport_local" | "upload" | "paste";
  ok: boolean;
  provider: string;
  title: string;
  sourceUrl?: string | null;
  fileName?: string;
  rawBytes: number;
  messageCount: number;
  duplicate?: boolean;
  access?: AccessCheckResult | null;
  error?: string | null;
}): string {
  return formatOpLog(
    input.op,
    {
      provider: input.provider,
      title: input.title,
      sourceUrl: input.sourceUrl ?? null,
      fileName: input.fileName ?? null,
      rawBytes: input.rawBytes,
      messageCount: input.messageCount,
      duplicate: Boolean(input.duplicate),
      error: input.error ?? null,
      access: input.access
        ? {
            accessStatus: input.access.accessStatus,
            httpStatus: input.access.httpStatus,
            fetchedBytes: input.access.fetchedBytes ?? null,
            truncated: input.access.truncated ?? false,
            lastError: input.access.lastError,
            message: input.access.message,
            importAllowed: input.access.importAllowed,
          }
        : null,
    },
    input.ok,
  );
}

function clip(text: string, max = 500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length} chars]`;
}

export function formatCouncilOpLog(input: {
  provider: string;
  task: {
    id: string;
    title: string;
    status: string;
    error: string | null;
    totalCostUsd: number | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    totalLatencyMs: number | null;
    selectedChatSourceIds: string[];
  };
  responses: Array<{
    agent: string;
    round: number;
    model: string;
    error: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    cost: number | null;
    latencyMs: number | null;
    requestId: string | null;
    responseText: string;
  }>;
  result: {
    status: string;
    finalEnforcedStatus: string | null;
    verdictOverride: boolean;
    overrideReason: string | null;
    blockers: string[];
    disagreements: string[];
    recommendation: string;
  } | null;
  exception?: unknown;
}): string {
  const failed = Boolean(input.task.error) || Boolean(input.exception) || input.task.status === "FAILED";
  return formatOpLog(
    "council_run",
    {
      provider: input.provider,
      taskId: input.task.id,
      taskTitle: input.task.title,
      status: input.task.status,
      error: input.task.error,
      selectedChatSourceIds: input.task.selectedChatSourceIds,
      totals: {
        costUsd: input.task.totalCostUsd,
        inputTokens: input.task.totalInputTokens,
        outputTokens: input.task.totalOutputTokens,
        latencyMs: input.task.totalLatencyMs,
      },
      responses: input.responses.map((row) => ({
        agent: row.agent,
        round: row.round,
        model: row.model,
        ok: !row.error,
        error: row.error,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        cost: row.cost,
        latencyMs: row.latencyMs,
        requestId: row.requestId,
        responsePreview: clip(row.responseText || ""),
      })),
      result: input.result
        ? {
            status: input.result.status,
            finalEnforcedStatus: input.result.finalEnforcedStatus,
            verdictOverride: input.result.verdictOverride,
            overrideReason: input.result.overrideReason,
            blockers: input.result.blockers,
            disagreements: input.result.disagreements,
            recommendationPreview: clip(input.result.recommendation || ""),
          }
        : null,
      ...(input.exception ? errorFields(input.exception) : {}),
    },
    !failed,
  );
}

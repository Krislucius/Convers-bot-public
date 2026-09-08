import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import type { CouncilMember } from "./members";
import type { DiscoverySnapshot, DiscoveredModel } from "./discover";
import type { AgentResponse, ProviderId } from "./types";
import type { NanoGptBillingMode } from "./nano-billing";
import type { DurableRunPublic } from "./durable-run";

export type StartCouncilInput = {
  taskId: string;
  provider: ProviderId;
  members: CouncilMember[];
  synthesizerModel: string;
  maxCostUsd: number;
  nanogptBilling?: NanoGptBillingMode;
  catalog?: DiscoveredModel[];
  scan?: DiscoverySnapshot | null;
  resumeResponses?: AgentResponse[];
};

export const startCouncilRun = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: StartCouncilInput) => data)
  .handler(async ({ context, data }): Promise<DurableRunPublic> => {
    const runner = await import("./durable-runner.server");
    const frozen = await runner.freezeFromAccount(context.userId, data);
    return runner.startServerCouncilRun({
      userId: context.userId,
      taskId: data.taskId,
      frozen,
    });
  });

export const stopCouncilRunFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { taskId: string; runId?: string }) => data)
  .handler(async ({ context, data }): Promise<DurableRunPublic | null> => {
    const runner = await import("./durable-runner.server");
    return runner.stopServerCouncilRun({ userId: context.userId, taskId: data.taskId, runId: data.runId });
  });

export const restartCouncilRunFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: StartCouncilInput) => data)
  .handler(async ({ context, data }): Promise<DurableRunPublic> => {
    const runner = await import("./durable-runner.server");
    const frozen = await runner.freezeFromAccount(context.userId, data);
    return runner.restartServerCouncilRun({
      userId: context.userId,
      taskId: data.taskId,
      frozen,
    });
  });

export const getCouncilRun = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { taskId?: string; runId?: string }) => data)
  .handler(async ({ context, data }): Promise<DurableRunPublic | null> => {
    const runner = await import("./durable-runner.server");
    return runner.getServerCouncilRun({ userId: context.userId, taskId: data.taskId, runId: data.runId });
  });

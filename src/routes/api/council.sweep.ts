import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/council/sweep")({
  server: {
    handlers: {
      GET: async ({ request }) => handleSweep(request),
      POST: async ({ request }) => handleSweep(request),
    },
  },
});

async function handleSweep(request: Request): Promise<Response> {
  const { authorizeSweepRequest, sweepUnauthorizedBody } = await import("@/lib/council/durable-waker.server");
  if (!authorizeSweepRequest(request)) {
    return Response.json(sweepUnauthorizedBody(), {
      status: 401,
      headers: { "www-authenticate": "Bearer", "cache-control": "no-store" },
    });
  }
  const { sweepServerCouncilRuns } = await import("@/lib/council/durable-runner.server");
  const result = await sweepServerCouncilRuns();
  return Response.json(
    {
      ok: true,
      waker: "vercel-cron",
      path: "/api/council/sweep",
      schedule: "* * * * *",
      intervalMs: result.intervalMs,
      maxDormantMs: result.maxDormantMs,
      wokenAt: result.wokenAt,
      considered: result.considered,
      reclaimed: result.reclaimed,
      runIds: result.runIds,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

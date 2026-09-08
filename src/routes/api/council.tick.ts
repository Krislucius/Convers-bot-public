import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/council/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { runId?: string; token?: string } = {};
        try {
          body = (await request.json()) as { runId?: string; token?: string };
        } catch {
          return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
        }
        const runId = String(body.runId ?? "").trim();
        const token = String(body.token ?? "").trim();
        if (!runId || !token) {
          return Response.json({ ok: false, error: "missing run" }, { status: 400 });
        }
        const { tickByToken } = await import("@/lib/council/durable-runner.server");
        const publicRun = await tickByToken(runId, token);
        if (!publicRun) return Response.json({ ok: false, error: "unknown run" }, { status: 404 });
        return Response.json(
          {
            ok: true,
            runId: publicRun.runId,
            status: publicRun.status,
            stage: publicRun.stage,
            lastProgressAt: publicRun.lastProgressAt,
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});

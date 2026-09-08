import {
  MAX_DORMANT_MS,
  SWEEP_INTERVAL_MS,
  SWEEP_PATH,
  SWEEP_SCHEDULE,
} from "./durable-run.ts";

const globalRef = globalThis as typeof globalThis & {
  __cbCouncilWaker__?: ReturnType<typeof setInterval>;
  __cbCouncilWakerStarted__?: boolean;
};

export function sweepUnauthorizedBody() {
  return {
    ok: false,
    error: "unauthorized",
    waker: "vercel-cron",
    path: SWEEP_PATH,
    schedule: SWEEP_SCHEDULE,
  };
}

export function authorizeSweepRequest(request: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? process.env.COUNCIL_SWEEP_TOKEN ?? "").trim();
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (secret && bearer && bearer === secret) return true;
  if (!process.env.VERCEL) return false;
  const ua = (request.headers.get("user-agent") ?? "").toLowerCase();
  const cronHeader = request.headers.get("x-vercel-cron");
  return ua.includes("vercel-cron") || cronHeader === "1";
}

export function shouldStartProcessWaker(): boolean {
  if (typeof window !== "undefined") return false;
  if (process.env.VERCEL) return false;
  if (process.env.CB_DISABLE_WAKER === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  if (process.execArgv.some((flag) => flag === "--test" || flag.startsWith("--test="))) return false;
  if (process.argv.some((flag) => flag === "--test" || flag.startsWith("--test="))) return false;
  return true;
}

export function ensureProcessWaker(): void {
  if (!shouldStartProcessWaker()) return;
  if (globalRef.__cbCouncilWakerStarted__) return;
  globalRef.__cbCouncilWakerStarted__ = true;
  const fire = () => {
    void import("./durable-runner.server.ts")
      .then((mod) => mod.sweepServerCouncilRuns())
      .catch((err) => {
        console.error("[council.waker]", err);
      });
  };
  const delay = setTimeout(fire, 2_000);
  delay.unref?.();
  const handle = setInterval(fire, SWEEP_INTERVAL_MS);
  handle.unref?.();
  globalRef.__cbCouncilWaker__ = handle;
}

export const PROCESS_WAKER_INTERVAL_MS = SWEEP_INTERVAL_MS;
export const PROCESS_WAKER_MAX_DORMANT_MS = MAX_DORMANT_MS;

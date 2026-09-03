const TRACE_KEY = "grok-auth.trace";
const DEBUG_COOKIE = "grok-auth.debug";
const MAX_ENTRIES = 40;
const LOGIN_LOG_FLAG = "__CB_LOGIN_LOG";

export type AuthTraceEntry = {
  t: string;
  event: string;
  [key: string]: unknown;
};

function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/token|password|secret|authorization|code|cookie=/i.test(key)) {
      out[key] = value == null || value === "" ? value : "[redacted]";
      continue;
    }
    out[key] = value;
  }
  return out;
}

function pushLoginLog(line: string): void {
  if (typeof window === "undefined") return;
  try {
    const w = window as Window & { [LOGIN_LOG_FLAG]?: string[] };
    const list = Array.isArray(w[LOGIN_LOG_FLAG]) ? w[LOGIN_LOG_FLAG] : [];
    list.push(line.slice(0, 180));
    w[LOGIN_LOG_FLAG] = list.slice(-MAX_ENTRIES);
  } catch {
    /* ignore */
  }
}

function briefLine(entry: AuthTraceEntry): string {
  const bits = [entry.event];
  for (const [key, value] of Object.entries(entry)) {
    if (key === "t" || key === "event") continue;
    if (value == null || value === "") continue;
    bits.push(`${key}=${typeof value === "object" ? "obj" : String(value)}`);
  }
  return bits.join(" ").slice(0, 180);
}

export function authTrace(event: string, data: Record<string, unknown> = {}): AuthTraceEntry {
  const entry: AuthTraceEntry = { t: new Date().toISOString(), event, ...sanitize(data) };
  console.log("[auth-trace]", JSON.stringify(entry));
  pushLoginLog(briefLine(entry));
  if (typeof window === "undefined") return entry;
  try {
    const prev = JSON.parse(window.sessionStorage.getItem(TRACE_KEY) || "[]") as unknown;
    const list = Array.isArray(prev) ? prev : [];
    list.push(entry);
    window.sessionStorage.setItem(TRACE_KEY, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch {
    /* ignore */
  }
  return entry;
}

export function readAuthTrace(): AuthTraceEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const prev = JSON.parse(window.sessionStorage.getItem(TRACE_KEY) || "[]") as unknown;
    return Array.isArray(prev) ? (prev as AuthTraceEntry[]) : [];
  } catch {
    return [];
  }
}

export function readLoginLog(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const list = (window as Window & { [LOGIN_LOG_FLAG]?: unknown })[LOGIN_LOG_FLAG];
    return Array.isArray(list) ? list.map((row) => String(row).slice(0, 180)) : [];
  } catch {
    return [];
  }
}

export function formatLoginLog(extra: Record<string, unknown> = {}): string {
  const flags = clientAuthFlags();
  const lines = [
    `stage: ${String(extra.stage ?? flags.path ?? "unknown")}`,
    `iframe: ${flags.iframe ? "1" : "0"}`,
    `returning: ${flags.returning ? "1" : "0"}`,
    `bearer: ${flags.hasBearer ? "1" : "0"}`,
  ];
  for (const [key, value] of Object.entries(extra)) {
    if (key === "stage") continue;
    if (value == null || value === "") continue;
    if (/token|password|secret|authorization|code|cookie=/i.test(key)) {
      lines.push(`${key}: [redacted]`);
      continue;
    }
    lines.push(`${key}: ${typeof value === "object" ? "obj" : String(value)}`.slice(0, 180));
  }
  for (const row of readLoginLog().slice(-12)) lines.push(row);
  return lines.join("\n");
}

export function readDebugCookie(): unknown {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DEBUG_COOKIE}=`));
  if (!match) return null;
  const raw = match.slice(`${DEBUG_COOKIE}=`.length);
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return raw;
  }
}

export function clientAuthFlags() {
  if (typeof window === "undefined") {
    return { iframe: false, returning: false, hasBearer: false, host: null, path: null };
  }
  let returning = false;
  let hasBearer = false;
  try {
    returning = window.sessionStorage.getItem("grok-auth.returning") === "1";
    hasBearer = Boolean(window.sessionStorage.getItem("grok-auth.bearer-token"));
  } catch {
    returning = false;
    hasBearer = false;
  }
  return {
    iframe: window.self !== window.top,
    returning,
    hasBearer,
    host: window.location.host,
    path: window.location.pathname,
  };
}

import { COUNCIL_ROLES, type CouncilRole } from "./roles.ts";

export type ModelAccess = "AVAILABLE" | "UNAVAILABLE" | "NOT_INCLUDED" | "UNKNOWN";

export type CatalogEntry = {
  id: string;
  name: string;
  contextLength: number | null;
  ownedBy: string;
};

export type ModelProbe = {
  id: string;
  status: number;
  error?: string;
  body?: string;
};

export type DiscoveredModel = {
  id: string;
  name: string;
  family: string;
  access: ModelAccess;
  recommendedRole: CouncilRole | null;
  contextTokens: number | null;
  reasoning: boolean;
  score: number;
  probed: boolean;
};

export type DiscoverySnapshot = {
  provider: string;
  fetchedAt: string;
  models: DiscoveredModel[];
  recommendedIds: string[];
};

export const MAX_PROBE_TARGETS = 8;
export const RECOMMEND_MIN = 2;
export const RECOMMEND_MAX = 5;

const FAMILY_PRIORITY = [
  "anthropic",
  "openai",
  "perplexity",
  "deepseek",
  "kimi",
  "google",
  "xai",
  "qwen",
  "mistral",
  "other",
] as const;

export type ModelFamily = (typeof FAMILY_PRIORITY)[number];

const PROVIDER_BRAND = /^(nanogpt|nano-gpt|nano gpt|openrouter|open-router|openrusrouter|open-rus-router)$/i;

/** Provider product names are not AI models and must never join the Council. */
export function isProviderBrandModel(id: string, name = ""): boolean {
  const idNorm = id.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (PROVIDER_BRAND.test(idNorm)) return true;
  const nameNorm = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return PROVIDER_BRAND.test(nameNorm);
}

export function familyOf(id: string, ownedBy = ""): ModelFamily {
  const text = `${id} ${ownedBy}`.toLowerCase();
  if (/\banthropic\b|\bclaude\b/.test(text)) return "anthropic";
  if (/\bopenai\b|\bgpt[-.]|\bo[1-4][-.]|\bo1\b|\bo3\b|\bo4\b/.test(text)) return "openai";
  if (/\bperplexity\b|\bpplx\b|\bsonar\b/.test(text)) return "perplexity";
  if (/\bdeepseek\b/.test(text)) return "deepseek";
  if (/\bmoonshot\b|\bkimi\b/.test(text)) return "kimi";
  if (/\bgoogle\b|\bgemini\b|\bpalm\b/.test(text)) return "google";
  if (/\bx-ai\b|\bxai\b|\bgrok\b/.test(text)) return "xai";
  if (/\bqwen\b|\balibaba\b/.test(text)) return "qwen";
  if (/\bmistral\b|\bmixtral\b/.test(text)) return "mistral";
  return "other";
}

export function looksReasoning(id: string, name = ""): boolean {
  const text = `${id} ${name}`.toLowerCase();
  return /\b(opus|o[1-4]|o1|o3|thinking|reason|r1|gpt-5|sonnet-4|sonnet-5|deepseek-r|kimi-k2)\b/.test(text);
}

export function scoreModel(entry: CatalogEntry): number {
  const family = familyOf(entry.id, entry.ownedBy);
  const familyScore: Record<ModelFamily, number> = {
    anthropic: 90,
    openai: 88,
    perplexity: 84,
    deepseek: 85,
    kimi: 83,
    google: 76,
    xai: 74,
    qwen: 72,
    mistral: 68,
    other: 50,
  };
  let score = familyScore[family];
  const text = `${entry.id} ${entry.name}`.toLowerCase();
  if (/\bopus\b|\bgpt-5\b|\bo3\b|\bo1\b|\bdeepseek-r1\b|\bthinking\b/.test(text)) score += 16;
  else if (/\bsonnet\b|\bgpt-4\.1\b|\bgpt-4o\b|\bkimi-k2\b|\br1\b/.test(text)) score += 10;
  if (/\bhaiku\b|\bmini\b|\bnano\b|\blite\b|\bfast\b|\btiny\b|\binstant\b/.test(text)) score -= 18;
  if ((entry.contextLength ?? 0) >= 200_000) score += 8;
  else if ((entry.contextLength ?? 0) >= 100_000) score += 5;
  if (/\bcoder\b|\bcode\b/.test(text)) score += 6;
  if (/\bsonar\b|\bonline\b|\bsearch\b/.test(text)) score += 6;
  return score;
}

export function parseCatalogBody(payload: unknown): CatalogEntry[] {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const rows = Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : [];
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = String(rec.id ?? rec.model ?? "").trim();
    const name = String(rec.name ?? rec.id ?? id);
    if (!id || seen.has(id) || isProviderBrandModel(id, name)) continue;
    seen.add(id);
    const ctx =
      Number(rec.context_length ?? rec.contextLength ?? rec.max_context ?? rec.context_window) || null;
    out.push({
      id,
      name,
      contextLength: ctx && Number.isFinite(ctx) ? ctx : null,
      ownedBy: String(rec.owned_by ?? rec.ownedBy ?? rec.architecture ?? ""),
    });
  }
  return out;
}

export function classifyProbe(probe: ModelProbe, catalogHas: boolean): ModelAccess {
  if (!catalogHas && (probe.status === 404 || probe.status === 400 || probe.status === 0)) {
    return "UNAVAILABLE";
  }
  const raw = `${probe.error ?? ""} ${probe.body ?? ""}`.toLowerCase();
  if (probe.status === 401) return "UNAVAILABLE";
  if (
    probe.status === 403 ||
    probe.status === 402 ||
    /not included|not (?:in|on) (?:your )?subscription|no access to this model|model not (?:allowed|enabled)|permission denied for model/.test(
      raw,
    )
  ) {
    if (/insufficient.?credit|payment required|add balance|quota/.test(raw) && probe.status === 402) {
      return "UNKNOWN";
    }
    return "NOT_INCLUDED";
  }
  if (probe.status === 404 || /model[_ ]?not[_ ]?found|unknown model|invalid model/.test(raw)) {
    return "UNAVAILABLE";
  }
  if (probe.status >= 200 && probe.status < 300) return "AVAILABLE";
  if (probe.status === 429 || probe.status >= 500 || probe.status === 0) return "UNKNOWN";
  if (!catalogHas) return "UNAVAILABLE";
  return "UNKNOWN";
}

export function pickProbeTargets(entries: CatalogEntry[], selectedIds: string[], cap = MAX_PROBE_TARGETS): string[] {
  const known = new Set(entries.map((row) => row.id));
  const ranked = [...entries].sort((a, b) => scoreModel(b) - scoreModel(a));
  const out: string[] = [];
  const add = (id: string) => {
    if (!id || out.includes(id) || isProviderBrandModel(id)) return;
    if (out.length >= cap) return;
    out.push(id);
  };
  for (const id of selectedIds) add(id);
  const usedFamily = new Set<string>();
  for (const row of ranked) {
    const family = familyOf(row.id, row.ownedBy);
    if (usedFamily.has(family)) continue;
    usedFamily.add(family);
    add(row.id);
  }
  for (const row of ranked) add(row.id);
  for (const id of selectedIds) {
    if (!known.has(id) && !out.includes(id) && !isProviderBrandModel(id)) {
      if (out.length >= cap) out[out.length - 1] = id;
      else out.push(id);
    }
  }
  return out;
}

function recommendedRoleFor(index: number, family: ModelFamily): CouncilRole {
  if (index === 0) return "LEAD_REASONER";
  if (family === "perplexity") return "RESEARCH";
  if (family === "xai" || family === "deepseek") return "ADVERSARIAL";
  if (family === "anthropic") return "FORMAL_REVIEW";
  return COUNCIL_ROLES[Math.min(index, COUNCIL_ROLES.length - 1)];
}

export function availableModels(models: DiscoveredModel[]): DiscoveredModel[] {
  return models.filter((row) => row.access === "AVAILABLE" && !isProviderBrandModel(row.id, row.name));
}

export function pruneToAvailable(ids: string[], models: DiscoveredModel[]): string[] {
  const ok = new Set(availableModels(models).map((row) => row.id));
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || !ok.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export function accessCounts(models: DiscoveredModel[]): Record<ModelAccess, number> {
  const counts: Record<ModelAccess, number> = {
    AVAILABLE: 0,
    NOT_INCLUDED: 0,
    UNAVAILABLE: 0,
    UNKNOWN: 0,
  };
  for (const row of models) counts[row.access] += 1;
  return counts;
}

export function buildDiscovery(
  provider: string,
  entries: CatalogEntry[],
  probes: ModelProbe[],
  selectedIds: string[] = [],
  fetchedAt = new Date().toISOString(),
): DiscoverySnapshot {
  const probeById = new Map(probes.map((row) => [row.id, row]));
  const anySuccess = probes.some((row) => row.status >= 200 && row.status < 300);
  const models: DiscoveredModel[] = entries.map((entry) => {
    const probe = probeById.get(entry.id);
    let access: ModelAccess = "UNKNOWN";
    let probed = false;
    if (probe) {
      probed = true;
      access = classifyProbe(probe, true);
      if (access === "UNKNOWN" && probe.status === 402 && anySuccess) access = "NOT_INCLUDED";
    }
    return {
      id: entry.id,
      name: entry.name || entry.id,
      family: familyOf(entry.id, entry.ownedBy),
      access,
      recommendedRole: null,
      contextTokens: entry.contextLength,
      reasoning: looksReasoning(entry.id, entry.name),
      score: scoreModel(entry),
      probed,
    };
  });
  for (const id of selectedIds) {
    if (!id.trim() || isProviderBrandModel(id) || models.some((row) => row.id === id)) continue;
    const probe = probeById.get(id);
    models.push({
      id,
      name: id,
      family: familyOf(id),
      access: "UNAVAILABLE",
      recommendedRole: null,
      contextTokens: null,
      reasoning: looksReasoning(id),
      score: 0,
      probed: Boolean(probe),
    });
  }
  const available = availableModels(models).sort((a, b) => b.score - a.score);
  const recommended = pickDiverse(available, Math.min(RECOMMEND_MAX, Math.max(available.length, 0)));
  const recommendedIds = recommended.map((row) => row.id);
  const byId = new Map(models.map((row) => [row.id, row]));
  recommended.forEach((row, index) => {
    const live = byId.get(row.id);
    if (live) live.recommendedRole = recommendedRoleFor(index, live.family as ModelFamily);
  });
  models.sort((a, b) => {
    const rec = Number(recommendedIds.includes(b.id)) - Number(recommendedIds.includes(a.id));
    if (rec) return rec;
    const av = Number(b.access === "AVAILABLE") - Number(a.access === "AVAILABLE");
    if (av) return av;
    return b.score - a.score;
  });
  return { provider, fetchedAt, models, recommendedIds };
}

export function pickDiverse(models: DiscoveredModel[], count: number): DiscoveredModel[] {
  const usable = availableModels(models).sort((a, b) => {
    const score = b.score - a.score;
    if (score) return score;
    return (
      (FAMILY_PRIORITY as readonly string[]).indexOf(a.family) -
      (FAMILY_PRIORITY as readonly string[]).indexOf(b.family)
    );
  });
  const out: DiscoveredModel[] = [];
  const used = new Set<string>();
  for (const row of usable) {
    if (out.length >= count) break;
    if (used.has(row.family) && row.family !== "other") continue;
    used.add(row.family);
    out.push(row);
  }
  for (const row of usable) {
    if (out.length >= count) break;
    if (out.some((item) => item.id === row.id)) continue;
    out.push(row);
  }
  return out.slice(0, count);
}

export function accessBlocksRun(access: ModelAccess): boolean {
  return access !== "AVAILABLE";
}

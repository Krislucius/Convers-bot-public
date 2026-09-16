import { hashContent } from "../history/hash.ts";
import type { ProjectFile } from "../council/types.ts";

export const INDEXER_VERSION = "repo-indexer-v1";
export const MAX_FILE_TEXT = 24_000;
export const MAX_FILES = 1500;

export const IMPLEMENTATION_STATUSES = [
  "VERIFIED_IMPLEMENTED",
  "IMPLEMENTED_UNVERIFIED",
  "PARTIAL",
  "DESIGNED_ONLY",
  "UNKNOWN",
] as const;

export type ImplementationStatusKind = (typeof IMPLEMENTATION_STATUSES)[number];

export type RepoCitation = {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  hash: string;
};

export type RepoFileRecord = {
  path: string;
  language: string;
  bytes: number;
  sha256: string;
  text: string;
  symbols: string[];
  isTest: boolean;
  isMigration: boolean;
  isConfig: boolean;
  generated: boolean;
};

export type RepoSnapshot = {
  fileId: string;
  filename: string;
  hash: string;
  indexerVersion: string;
  files: RepoFileRecord[];
  fileCount: number;
  sourceCount: number;
  testCount: number;
  migrationCount: number;
};

export type ImplementationRow = {
  module: string;
  status: ImplementationStatusKind;
  evidence: string;
  citations: string[];
};

export type ImplementationReport = {
  indexerVersion: string;
  repositoryHash: string | null;
  snapshots: RepoSnapshot[];
  filesIndexed: number;
  coverage: {
    modules: number;
    verified: number;
    unverified: number;
    partial: number;
    designedOnly: number;
    unknown: number;
  };
  rows: ImplementationRow[];
  claims: Array<{ claim: string; citation: string; evidenceClass: "IMPLEMENTATION_EVIDENCE" }>;
  citations: string[];
  gaps: string[];
  recommendations: string[];
  required: string[];
  missingRepository: boolean;
  conflict: "REPOSITORY_SOURCE_CONFLICT" | null;
};

export type ArchitectureModule = {
  moduleId: string;
  implementationPath: string;
  responsibilities?: string[];
};

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".svn",
  "dist",
  "build",
  ".next",
  ".vercel",
  ".output",
  ".nitro",
  ".tanstack",
  "coverage",
  "vendor",
  "__pycache__",
  ".cache",
  "artifacts",
  "screenshots",
]);

const SOURCE_EXT: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
  ".java": "java",
  ".kt": "kt",
  ".sql": "sql",
  ".json": "json",
  ".yml": "yml",
  ".yaml": "yml",
  ".toml": "toml",
  ".md": "md",
  ".css": "css",
  ".html": "html",
};

const CODE_LANG = new Set(["ts", "js", "py", "go", "rs", "java", "kt", "sql"]);
const DOC_LANG = new Set(["md", "html"]);

export function isCodeLanguage(language: string): boolean {
  return CODE_LANG.has(language);
}

export function isIgnoredRepoPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.some((part) => IGNORED_SEGMENTS.has(part))) return true;
  const base = parts.at(-1) ?? "";
  if (base.startsWith(".") && base !== ".env.example") return true;
  if (base.endsWith(".min.js") || base.endsWith(".map") || base.endsWith(".wasm")) return true;
  return false;
}

export function languageForPath(path: string): string | null {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return SOURCE_EXT[lower.slice(dot)] ?? null;
}

export function isSourcePath(path: string): boolean {
  return languageForPath(path) != null && !isIgnoredRepoPath(path);
}

function isTestPath(path: string): boolean {
  const lower = path.replaceAll("\\", "/").toLowerCase();
  return (
    /\.(test|spec)\.[a-z0-9]+$/.test(lower) ||
    /(^|\/)tests?\//.test(lower) ||
    /(^|\/)__tests__\//.test(lower)
  );
}

function isMigrationPath(path: string): boolean {
  const lower = path.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)migrations?\//.test(lower) || /\d{3,}.*\.sql$/.test(lower);
}

function isConfigPath(path: string): boolean {
  const base = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return (
    base === "package.json" ||
    base === "tsconfig.json" ||
    base === "vite.config.ts" ||
    base.endsWith(".config.ts") ||
    base.endsWith(".config.js") ||
    base === "vercel.json"
  );
}

export function extractSymbols(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=/g,
    /\b(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_][\w]*)/g,
    /\bdef\s+([A-Za-z_][\w]*)\s*\(/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const name = match[1];
      if (name) out.push(name);
    }
  }
  return [...new Set(out)].slice(0, 80);
}

export function formatRepoCitation(input: RepoCitation): string {
  const symbol = input.symbol ?? "";
  return `[REPO:${input.path}:${symbol}:${input.startLine}-${input.endLine}@${input.hash}]`;
}

export function parseRepoCitation(text: string): RepoCitation | null {
  const match = text.match(/^\[REPO:([^:\]]+):([^:\]]*?):(\d+)-(\d+)@([a-f0-9]+)\]$/i);
  if (!match) return null;
  return {
    path: match[1] ?? "",
    symbol: match[2] || null,
    startLine: Number(match[3]),
    endLine: Number(match[4]),
    hash: match[5] ?? "",
  };
}

function shortHash(value: string): string {
  return hashContent(value).replace(/^sha256:/, "").slice(0, 12);
}

function lineSpan(text: string, needle: string): { start: number; end: number } {
  const lines = text.split(/\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) return { start: 1, end: Math.min(20, lines.length || 1) };
  return { start: index + 1, end: Math.min(index + 3, lines.length) };
}

export function clipSourceText(text: string): string {
  if (text.length <= MAX_FILE_TEXT) return text;
  return `${text.slice(0, MAX_FILE_TEXT)}\n`;
}

export function clipSourceTree(
  tree: Array<{ path: string; text: string; bytes?: number }> | null | undefined,
): Array<{ path: string; text: string; bytes: number }> {
  return (tree ?? []).slice(0, MAX_FILES).map((row) => ({
    path: row.path.replaceAll("\\", "/"),
    bytes: row.bytes ?? row.text.length,
    text: clipSourceText(row.text ?? ""),
  }));
}

export function fileRecordFrom(path: string, text: string): RepoFileRecord {
  const clipped = clipSourceText(text);
  return {
    path,
    language: languageForPath(path) ?? "text",
    bytes: text.length,
    sha256: shortHash(`${path}\n${clipped}`),
    text: clipped,
    symbols: extractSymbols(clipped),
    isTest: isTestPath(path),
    isMigration: isMigrationPath(path),
    isConfig: isConfigPath(path),
    generated: isIgnoredRepoPath(path),
  };
}

export function snapshotFromTree(input: {
  fileId: string;
  filename: string;
  members: string[];
  sourceTree?: Array<{ path: string; text: string; bytes?: number }> | null;
  extractedText?: string;
}): RepoSnapshot {
  const files: RepoFileRecord[] = [];
  const seen = new Set<string>();
  for (const row of input.sourceTree ?? []) {
    const path = row.path.replaceAll("\\", "/");
    if (!isSourcePath(path) || seen.has(path)) continue;
    seen.add(path);
    files.push(fileRecordFrom(path, row.text ?? ""));
    if (files.length >= MAX_FILES) break;
  }
  if (!files.length) {
    for (const raw of input.members) {
      const path = raw.replaceAll("\\", "/");
      if (!isSourcePath(path) || seen.has(path)) continue;
      seen.add(path);
      const heading = new RegExp(`(?:^|\\n)## ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*?)(?=\\n## |$)`);
      const match = input.extractedText?.match(heading);
      files.push(fileRecordFrom(path, match?.[1] ?? ""));
      if (files.length >= MAX_FILES) break;
    }
  }
  const live = files.filter((row) => !row.generated);
  const hash = shortHash(
    live
      .map((row) => `${row.path}:${row.sha256}`)
      .sort()
      .join("\n"),
  );
  return {
    fileId: input.fileId,
    filename: input.filename,
    hash,
    indexerVersion: INDEXER_VERSION,
    files: live,
    fileCount: live.length,
    sourceCount: live.filter((row) => !row.isTest && !row.isConfig).length,
    testCount: live.filter((row) => row.isTest).length,
    migrationCount: live.filter((row) => row.isMigration).length,
  };
}

function looksLikeZip(file: Pick<ProjectFile, "kind" | "filename" | "members">): boolean {
  return file.kind === "ZIP" || file.filename.toLowerCase().endsWith(".zip") || file.members.length > 0;
}

function pathMatchesModule(filePath: string, implementationPath: string): boolean {
  const left = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const right = implementationPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!right) return false;
  if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) return true;
  const base = right.split("/").filter(Boolean).slice(-2).join("/");
  return Boolean(base) && left.includes(base);
}

function hasTestFor(modulePath: string, files: RepoFileRecord[]): boolean {
  const stem = modulePath.replace(/\.[a-z0-9]+$/i, "").split("/").pop() ?? "";
  return files.some((row) => {
    if (!row.isTest) return false;
    if (pathMatchesModule(row.path, modulePath)) return true;
    return stem.length > 2 && row.path.toLowerCase().includes(stem.toLowerCase());
  });
}

function citeFile(file: RepoFileRecord, snapshotHash: string, symbol?: string): string {
  const needle = symbol && file.text.includes(symbol) ? symbol : file.path.split("/").pop() ?? file.path;
  const span = lineSpan(file.text, needle);
  return formatRepoCitation({
    path: file.path,
    symbol: symbol ?? null,
    startLine: span.start,
    endLine: span.end,
    hash: snapshotHash,
  });
}

function docsMention(mod: ArchitectureModule, files: RepoFileRecord[], designMentions: string[]): boolean {
  const needles = [mod.moduleId.toLowerCase(), mod.implementationPath.toLowerCase()].filter(Boolean);
  if (designMentions.some((row) => needles.some((needle) => row.includes(needle)))) return true;
  return files.some((file) => {
    if (!DOC_LANG.has(file.language)) return false;
    const hay = `${file.path}\n${file.text}`.toLowerCase();
    return needles.some((needle) => hay.includes(needle));
  });
}

export function classifyModules(input: {
  modules: ArchitectureModule[];
  snapshot: RepoSnapshot | null;
  designMentions?: string[];
}): ImplementationRow[] {
  const files = input.snapshot?.files ?? [];
  const hash = input.snapshot?.hash ?? "missing";
  const design = (input.designMentions ?? []).map((row) => row.toLowerCase());
  if (!input.snapshot) {
    return input.modules.map((mod) => ({
      module: mod.moduleId,
      status: "UNKNOWN" as const,
      evidence: "No repository evidence selected.",
      citations: [],
    }));
  }
  return input.modules.map((mod) => {
    const matches = files.filter(
      (file) => pathMatchesModule(file.path, mod.implementationPath) && isCodeLanguage(file.language),
    );
    const mentioned = docsMention(mod, files, design);
    if (!matches.length) {
      return {
        module: mod.moduleId,
        status: mentioned ? "DESIGNED_ONLY" : "UNKNOWN",
        evidence: mentioned
          ? "Architecture or chat evidence mentions this module; the repository has no supporting implementation file."
          : "No matching source file in the authoritative repository.",
        citations: [],
      };
    }
    const withText = matches.filter((row) => row.text.trim().length > 0);
    const tests = hasTestFor(mod.implementationPath, files);
    const imported = files.some(
      (file) =>
        isCodeLanguage(file.language) &&
        !matches.includes(file) &&
        (file.text.includes(mod.implementationPath) ||
          file.text.includes(mod.moduleId) ||
          matches.some((hit) => file.text.includes(hit.path.split("/").pop() ?? ""))),
    );
    const citations = matches.slice(0, 4).map((file) => citeFile(file, hash, file.symbols[0]));
    if (withText.length && tests) {
      return {
        module: mod.moduleId,
        status: "VERIFIED_IMPLEMENTED",
        evidence: imported
          ? `Source, integration, and tests exist for ${mod.implementationPath}.`
          : `Implementation and tests exist for ${mod.implementationPath}.`,
        citations,
      };
    }
    if (withText.length && imported) {
      return {
        module: mod.moduleId,
        status: "IMPLEMENTED_UNVERIFIED",
        evidence: `Code exists and is referenced, but tests do not prove behavior.`,
        citations,
      };
    }
    if (withText.length) {
      return {
        module: mod.moduleId,
        status: "IMPLEMENTED_UNVERIFIED",
        evidence: `Source exists at ${matches[0]?.path}; integration/behavior is not proven.`,
        citations,
      };
    }
    return {
      module: mod.moduleId,
      status: "PARTIAL",
      evidence: `Only part of ${mod.implementationPath} is present in the repository.`,
      citations,
    };
  });
}

export function modulesFromSnapshot(snapshot: RepoSnapshot | null): ArchitectureModule[] {
  if (!snapshot) return [];
  const registry = snapshot.files.find((file) => /(^|\/)MODULE_REGISTRY\.json$/i.test(file.path));
  if (registry?.text) {
    try {
      const parsed = JSON.parse(registry.text) as { modules?: Array<Record<string, unknown>> };
      const rows = Array.isArray(parsed.modules) ? parsed.modules : [];
      const mapped = rows
        .filter((row) => String(row.status ?? "ACTIVE").toUpperCase() === "ACTIVE")
        .map((row) => ({
          moduleId: String(row.module_id ?? row.moduleId ?? "").trim(),
          implementationPath: String(row.implementation_path ?? row.implementationPath ?? "").trim(),
          responsibilities: Array.isArray(row.responsibilities)
            ? row.responsibilities.map((item) => String(item))
            : undefined,
        }))
        .filter((row) => row.moduleId && row.implementationPath);
      if (mapped.length) return mapped.slice(0, 80);
    } catch {
      /* fall through to path inference */
    }
  }
  const dirs = new Set<string>();
  for (const file of snapshot.files) {
    if (!isCodeLanguage(file.language) || file.isTest) continue;
    const parts = file.path.replaceAll("\\", "/").split("/").filter(Boolean);
    if (parts[0] === "src" && parts.length >= 3) dirs.add(parts.slice(0, 3).join("/"));
    else if (parts.length >= 2) dirs.add(parts.slice(0, 2).join("/"));
  }
  return [...dirs].slice(0, 24).map((path) => ({
    moduleId: path.replaceAll("/", "."),
    implementationPath: path,
  }));
}

function unknownRepositoryRow(evidence: string): ImplementationRow {
  return {
    module: "repository",
    status: "UNKNOWN",
    evidence,
    citations: [],
  };
}

export function indexSelectedRepositories(input: {
  files: ProjectFile[];
  modules?: ArchitectureModule[];
  designMentions?: string[];
}): ImplementationReport {
  const selected = input.files.filter((file) => looksLikeZip(file) || (file.sourceTree && file.sourceTree.length));
  const snapshots = selected.map((file) =>
    snapshotFromTree({
      fileId: file.id,
      filename: file.filename,
      members: file.members,
      sourceTree: file.sourceTree,
      extractedText: file.extractedText,
    }),
  );
  const hashes = [...new Set(snapshots.map((row) => row.hash).filter(Boolean))];
  const conflict = hashes.length > 1 ? ("REPOSITORY_SOURCE_CONFLICT" as const) : null;
  const snapshot = conflict ? null : (snapshots[0] ?? null);
  const inferred = snapshot ? modulesFromSnapshot(snapshot) : [];
  const modules = input.modules?.length ? input.modules : inferred;
  const rows = classifyModules({
    modules: modules.length ? modules : [ { moduleId: "repository", implementationPath: "" } ],
    snapshot: conflict ? null : snapshot,
    designMentions: input.designMentions,
  });
  if (conflict) {
    if (!rows.length) rows.push(unknownRepositoryRow("REPOSITORY_SOURCE_CONFLICT: multiple selected snapshots do not match."));
    for (const row of rows) {
      row.status = "UNKNOWN";
      row.evidence = "REPOSITORY_SOURCE_CONFLICT: multiple selected snapshots do not match.";
      row.citations = [];
    }
  }
  const claims = rows
    .filter((row) => row.citations.length)
    .map((row) => ({
      claim: `${row.module} is ${row.status}.`,
      citation: row.citations[0] ?? "",
      evidenceClass: "IMPLEMENTATION_EVIDENCE" as const,
    }));
  const coverage = {
    modules: rows.length,
    verified: rows.filter((row) => row.status === "VERIFIED_IMPLEMENTED").length,
    unverified: rows.filter((row) => row.status === "IMPLEMENTED_UNVERIFIED").length,
    partial: rows.filter((row) => row.status === "PARTIAL").length,
    designedOnly: rows.filter((row) => row.status === "DESIGNED_ONLY").length,
    unknown: rows.filter((row) => row.status === "UNKNOWN").length,
  };
  const missingRepository = snapshots.length === 0;
  const gaps = rows
    .filter((row) => row.status === "DESIGNED_ONLY" || row.status === "PARTIAL" || row.status === "UNKNOWN")
    .map((row) => `${row.module}: ${row.status}`);
  const recommendations: string[] = [];
  const required: string[] = [];
  if (conflict) {
    required.push("Select exactly one authoritative repository snapshot.");
    recommendations.push("Do not merge conflicting source archives.");
  } else if (missingRepository) {
    recommendations.push("Attach a source zip to verify implementation independently of design evidence.");
  } else if (coverage.designedOnly || coverage.unknown) {
    recommendations.push("Treat design/chat claims as DESIGN_EVIDENCE only until repository files exist.");
  }
  return {
    indexerVersion: INDEXER_VERSION,
    repositoryHash: snapshot?.hash ?? null,
    snapshots,
    filesIndexed: snapshot?.fileCount ?? 0,
    coverage,
    rows,
    claims,
    citations: [...new Set(rows.flatMap((row) => row.citations))],
    gaps,
    recommendations,
    required,
    missingRepository,
    conflict,
  };
}

#!/usr/bin/env node
/**
 * Architecture lock preflight. Future patches must pass this before editing source.
 *
 *   npm run arch:preflight
 *   node scripts/arch-preflight.mjs --write-lock
 *   node scripts/arch-preflight.mjs --expect-revision CB-ARCH-20260829-001 --target-modules council.orchestrator
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ID = "01a048b8-c1f7-7382-9dfd-fb30bff7137d";
export const PRODUCTION_HOST = "https://swift-lake-solar-cosmic.grok.me";
export const ARCHITECTURE_REVISION = "CB-ARCH-20260901-002";

const here = dirname(fileURLToPath(import.meta.url));
export function repoRoot(from = here) {
  return join(from, "..");
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function read(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

export function schemaHash(root) {
  const dir = join(root, "migrations");
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const body = names.map((name) => `-- ${name}\n${readFileSync(join(dir, name), "utf8")}`).join("\n");
  return sha256(body);
}

export function moduleRegistryHash(root) {
  const parsed = JSON.parse(read(root, "docs/MODULE_REGISTRY.json"));
  return sha256(JSON.stringify(parsed));
}

export function architectureHash(root) {
  const parts = [
    read(root, "docs/ARCHITECTURE.md"),
    read(root, "docs/ARCHITECTURE_DECISIONS.md"),
    read(root, "docs/CURRENT_SYSTEM_STATE.md"),
    read(root, "src/lib/architecture/identity.ts"),
    read(root, "src/lib/architecture/contracts.ts"),
  ];
  return sha256(parts.join("\n\0\n"));
}

export function criticalContractHash(root) {
  const protocol = read(root, "src/lib/council/protocol.ts");
  const taskMode = read(root, "src/lib/council/task-mode.ts");
  const orchestrate = read(root, "src/lib/council/orchestrate.ts");
  const identity = read(root, "src/lib/architecture/identity.ts");
  const packPath = join(root, "src/lib/evidence/pack.ts");
  const pipelinePath = join(root, "src/lib/evidence/pipeline.ts");
  const tokensPath = join(root, "src/lib/evidence/tokens.ts");
  const packetPath = join(root, "src/lib/council/packet.ts");
  const reviewPath = join(root, "src/lib/council/review.ts");
  const evaluatePath = join(root, "src/lib/council/evaluate.ts");
  const pack = existsSync(packPath) ? read(root, "src/lib/evidence/pack.ts") : "";
  const pipeline = existsSync(pipelinePath) ? read(root, "src/lib/evidence/pipeline.ts") : "";
  const tokens = existsSync(tokensPath) ? read(root, "src/lib/evidence/tokens.ts") : "";
  const packet = existsSync(packetPath) ? read(root, "src/lib/council/packet.ts") : "";
  const review = existsSync(reviewPath) ? read(root, "src/lib/council/review.ts") : "";
  const evaluate = existsSync(evaluatePath) ? read(root, "src/lib/council/evaluate.ts") : "";
  const contracts = read(root, "src/lib/architecture/contracts.ts");
  const tokenLimit = contracts.match(/export const CURRENT_CONTEXT_TOKEN_LIMIT = (\d+);/)?.[1] ?? "";
  const tokenBound = protocol.includes("countTokens(ctx)") && protocol.includes("CONTEXT_TOKEN_LIMIT");
  const packer =
    pack.includes("export function packEvidence") &&
    pack.includes("countTokens") &&
    tokens.includes("export function countTokens") &&
    pipeline.includes("export function runEvidencePipeline")
      ? "evidenceLedgerPacker"
      : "UNKNOWN";
  const modes = taskMode.includes('"CREATE"') && taskMode.includes('"REVIEW"') && taskMode.includes('"DECIDE"');
  const singleOrch = orchestrate.includes("export async function runCouncil");
  const closedLoop =
    packet.includes("export function buildImplementationPacket") &&
    packet.includes("serializePacketHandoff") &&
    review.includes("PASS") &&
    review.includes("PATCH") &&
    evaluate.includes("evaluateProject");
  return sha256(
    JSON.stringify({
      project: PROJECT_ID,
      host: PRODUCTION_HOST,
      revision: ARCHITECTURE_REVISION,
      CONTEXT_TOKEN_LIMIT: tokenLimit,
      tokenBound,
      packer,
      modes,
      singleOrch,
      closedLoop,
      identity,
      tokens,
      pack,
      pipeline,
      packet,
      review,
      evaluate,
    }),
  );
}

export function readLock(root) {
  return JSON.parse(read(root, "docs/ARCHITECTURE_LOCK.json"));
}

export function readRegistry(root) {
  return JSON.parse(read(root, "docs/MODULE_REGISTRY.json"));
}

export function currentFingerprints(root) {
  return {
    architecture_hash: architectureHash(root),
    module_registry_hash: moduleRegistryHash(root),
    schema_hash: schemaHash(root),
    critical_contract_hash: criticalContractHash(root),
  };
}

export function writeLock(root) {
  const current = JSON.parse(read(root, "docs/ARCHITECTURE_LOCK.json"));
  const hashes = currentFingerprints(root);
  const next = {
    ...current,
    project_id: PROJECT_ID,
    production_host: PRODUCTION_HOST,
    architecture_revision: ARCHITECTURE_REVISION,
    ...hashes,
  };
  writeFileSync(join(root, "docs/ARCHITECTURE_LOCK.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function verifyLock(root, opts = {}) {
  const errors = [];
  const idPath = join(root, ".project_id");
  const projectId = existsSync(idPath) ? readFileSync(idPath, "utf8").trim() : "";
  if (projectId !== PROJECT_ID) {
    errors.push({
      code: "AUTHORITATIVE_PROJECT_NOT_VERIFIED",
      message: `Expected ${PROJECT_ID}, got ${projectId || "(missing .project_id)"}`,
    });
  }
  const lock = readLock(root);
  const hashes = currentFingerprints(root);
  const expectedRevision = opts.expectRevision ?? lock.architecture_revision;
  if (expectedRevision !== ARCHITECTURE_REVISION || lock.architecture_revision !== ARCHITECTURE_REVISION) {
    errors.push({
      code: "STALE_PATCH_BASE",
      message: `Patch expects ${expectedRevision}. Current system: ${ARCHITECTURE_REVISION}.`,
    });
  }
  if (lock.project_id !== PROJECT_ID) {
    errors.push({ code: "AUTHORITATIVE_PROJECT_NOT_VERIFIED", message: "Lock project_id mismatch." });
  }
  if (lock.production_host !== PRODUCTION_HOST) {
    errors.push({ code: "HOST_MISMATCH", message: "Lock production_host mismatch." });
  }
  if (hashes.schema_hash !== lock.schema_hash) {
    errors.push({ code: "SCHEMA_DRIFT", message: "Schema hash does not match ARCHITECTURE_LOCK." });
  }
  if (hashes.architecture_hash !== lock.architecture_hash) {
    errors.push({ code: "LOCK_MISMATCH", message: "Architecture hash does not match ARCHITECTURE_LOCK." });
  }
  if (hashes.module_registry_hash !== lock.module_registry_hash) {
    errors.push({ code: "LOCK_MISMATCH", message: "Module registry hash does not match ARCHITECTURE_LOCK." });
  }
  if (hashes.critical_contract_hash !== lock.critical_contract_hash) {
    errors.push({ code: "LOCK_MISMATCH", message: "Critical contract hash does not match ARCHITECTURE_LOCK." });
  }
  const registry = readRegistry(root);
  const byId = new Map((registry.modules ?? []).map((row) => [row.module_id, row]));
  for (const moduleId of opts.targetModules ?? []) {
    const row = byId.get(moduleId);
    if (!row) {
      errors.push({ code: "UNKNOWN_MODULE", message: `Module ${moduleId} is not in MODULE_REGISTRY.` });
      continue;
    }
    const status = String(row.status).toUpperCase();
    if (status === "SUPERSEDED" || status === "REMOVED") {
      errors.push({
        code: "SUPERSEDED_MODULE",
        message: `Module ${moduleId} is ${status}. Do not patch it.`,
      });
    }
  }
  const pythonMain = join(root, "conversation-bot", "app", "main.py");
  if (existsSync(pythonMain) && !existsSync(join(root, "conversation-bot", "LEGACY.md"))) {
    errors.push({
      code: "DUPLICATE_AUTHORITY",
      message: "Python tree exists without LEGACY.md marker.",
    });
  }
  return { ok: errors.length === 0, errors, hashes, lock, projectId };
}

function parseArgs(argv) {
  const out = { writeLock: false, expectRevision: null, targetModules: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write-lock") out.writeLock = true;
    else if (arg === "--expect-revision") out.expectRevision = argv[++i];
    else if (arg === "--target-modules") {
      out.targetModules = String(argv[++i] ?? "")
        .split(",")
        .map((row) => row.trim())
        .filter(Boolean);
    }
  }
  return out;
}

export function isMainModule(url = import.meta.url) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  if (args.writeLock) {
    const lock = writeLock(root);
    process.stdout.write(`${JSON.stringify({ ok: true, lock }, null, 2)}\n`);
    process.exit(0);
  }
  const result = verifyLock(root, args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

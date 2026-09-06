import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { Field, Page, PageHeader, Panel, PrimaryButton, TextInput } from "@/components/council-ui";
import { ModelCatalogPanel } from "@/components/model-catalog";
import { OpLogPanel } from "@/components/op-log";
import { SystemInfoPanel } from "@/components/system-info";
import { describeKey, keyFingerprint, redact, sanitizeApiKey } from "@/lib/council/api-key";
import { currentConnectionView } from "@/lib/council/discover";
import { emptyAccessCounts, formatTestLog } from "@/lib/council/test-log";
import { assertAvailableSelection, MAX_COUNCIL_MEMBERS, attemptLimit, expectedSuccessfulCalls, membersFromIds } from "@/lib/council/members";
import { checkAccess, completeChat, testProvider } from "@/lib/council/openrouter";
import { PROVIDER_IDS, PROVIDERS, slotFor } from "@/lib/council/providers";
import { refreshAccountSettings, useSession, type SessionConfig } from "@/lib/council/session";
import type { AccountSettingsPublic, ProviderId } from "@/lib/council/types";
import { billingLabel, type NanoGptBillingMode } from "@/lib/council/nano-billing";
import { runSaveAcceptance } from "@/lib/council/save-acceptance";
import {
  applyDiscovery,
  attemptIdFromLog,
  emptyScan,
  invalidateScan,
  persistScanFields,
  runCanonicalScan,
  shouldApplyAttempt,
  type ScanAttempt,
} from "@/lib/council/settings-scan";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function attemptFromConfig(config: SessionConfig): ScanAttempt {
  const lastTestOk = config.lastTestOk;
  return {
    attemptId: attemptIdFromLog(config.lastTestLog) || "hydrated",
    status: lastTestOk === true ? "CONNECTED" : lastTestOk === false ? "FAILED" : "IDLE",
    catalog: config.catalog,
    selectedIds: config.selectedModelIds,
    synthesizerModel: config.synthesizerModel,
    log: config.lastTestLog,
    error: lastTestOk === false ? "Connection failed." : null,
    lastTestOk,
    lastTestAt: config.lastTestAt,
  };
}

function SettingsPage() {
  const { config, save, clearKey, setProvider, setNanoGptBilling, hydrateFromAccount } = useSession();
  const provider = config.provider;
  const meta = PROVIDERS[provider];
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [scan, setScan] = useState<ScanAttempt>(() => attemptFromConfig(config));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const scanningRef = useRef(false);
  const attemptRef = useRef(scan.attemptId);
  const keyHint = useMemo(() => describeKey(apiKey, provider), [apiKey, provider]);
  const savedSlot = slotFor(config, provider);
  const view = currentConnectionView(scan.lastTestOk, scan.catalog);
  const statusLabel = scan.status === "TESTING" ? "TESTING" : view.status;
  const liveCatalog = view.catalog;
  const members = membersFromIds(scan.selectedIds, liveCatalog?.models ?? scan.catalog?.models ?? []);
  const expected = expectedSuccessfulCalls(members.length || 2);
  const limit = attemptLimit(members.length || 2);
  const selectionError = liveCatalog
    ? assertAvailableSelection(scan.selectedIds, liveCatalog.models)
    : scan.status === "TESTING"
      ? null
      : "Test Connection or Save to discover AVAILABLE models. Only AVAILABLE models from the current scan can join the Council.";
  const lastTested = scan.lastTestAt
    ? new Date(scan.lastTestAt).toLocaleString()
    : liveCatalog?.fetchedAt
      ? new Date(liveCatalog.fetchedAt).toLocaleString()
      : "Never";

  useEffect(() => {
    if (scanningRef.current) return;
    setScan(attemptFromConfig(config));
    attemptRef.current = attemptIdFromLog(config.lastTestLog) || "hydrated";
  }, [
    config.provider,
    config.nanogptBilling,
    config.selectedModelIds,
    config.synthesizerModel,
    config.catalog,
    config.lastTestLog,
    config.lastTestOk,
    config.lastTestAt,
  ]);

  function clientMeta(raw: string, sanitized: string) {
    const hint = describeKey(raw || sanitized, provider);
    const fp = keyFingerprint(sanitized, provider);
    return {
      pasted_chars: raw.length,
      sanitized_chars: sanitized.length,
      key_prefix: fp.prefix.replace(/[A-Za-z0-9]$/, ""),
      local_describe: hint.text || "(empty)",
    };
  }

  function localFailLog(reason: string, raw: string, sanitized: string, extra?: Record<string, unknown>) {
    return redact(
      formatTestLog(
        {
          result: "FAIL",
          provider,
          connection: { status: "FAILED", detail: reason },
          catalog: { http_status: 0, model_count: 0, response_shape: "none" },
          probes: { performed: 0, ids: [] },
          access: emptyAccessCounts(),
          recommended: [],
          selected: [],
          warnings: [],
          error: reason,
          extra: { probe: "local (request not sent)", client: clientMeta(raw, sanitized), ...extra },
        },
        sanitized,
      ),
      sanitized,
    );
  }

  function mergeLog(serverLog: string, raw: string, sanitized: string) {
    try {
      const data = JSON.parse(serverLog) as Record<string, unknown>;
      data.client = clientMeta(raw, sanitized);
      return redact(JSON.stringify(data, null, 2), sanitized);
    } catch {
      return localFailLog("Connection failed.", raw, sanitized, { raw_log: serverLog });
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!pasted) return;
    event.preventDefault();
    setApiKey(sanitizeApiKey(pasted, provider) || pasted.trim());
  }

  function onSwitch(next: ProviderId) {
    if (next === provider) return;
    scanningRef.current = false;
    setProvider(next);
    setApiKey("");
    setShowKey(false);
    setMsg("");
    setQuery("");
    setScan(emptyScan());
  }

  function onBilling(next: NanoGptBillingMode) {
    if (next === config.nanogptBilling) return;
    scanningRef.current = false;
    setNanoGptBilling(next);
    setMsg("");
    setQuery("");
    setScan(emptyScan());
  }

  async function runCanonicalDiscovery(mode: "save" | "refresh") {
    const raw = apiKey;
    const sanitized = sanitizeApiKey(apiKey, provider);
    const previous = scan;
    if (!sanitized && !savedSlot.saved) {
      const attemptId = crypto.randomUUID();
      attemptRef.current = attemptId;
      const failed = applyDiscovery({
        attemptId,
        report: { ok: false, error: "Paste your API key first.", log: localFailLog("Paste your API key first.", raw, "") },
        previousIds: previous.selectedIds,
        previousSynth: previous.synthesizerModel,
        previousCatalog: previous.catalog,
      });
      setScan(failed);
      setMsg("Paste your API key first.");
      return;
    }
    const attemptId = crypto.randomUUID();
    attemptRef.current = attemptId;
    scanningRef.current = true;
    setBusy(true);
    setScan(invalidateScan(previous, attemptId));
    setMsg(mode === "save" ? "Saving, then discovering models…" : "Discovering models and checking account access…");
    const persistBase = {
      provider,
      apiKey: sanitized,
      members: membersFromIds(previous.selectedIds, previous.catalog?.models ?? []),
      synthesizerModel: previous.synthesizerModel,
      maxCostUsd: config.maxCostUsd > 0 ? config.maxCostUsd : 1,
      selectedModelIds: previous.selectedIds,
      nanogptBilling: config.nanogptBilling,
    };
    let persisted: AccountSettingsPublic | null = null;
    try {
      const out = await runCanonicalScan({
        mode,
        previous,
        persistConfig:
          mode === "save"
            ? async () => {
                persisted = await save({
                  ...persistBase,
                  lastTestOk: null,
                  lastTestLog: "",
                });
              }
            : undefined,
        discover: async () => {
          const report = await testProvider(persistBase);
          return {
            ok: report.ok,
            error: report.error,
            catalog: report.catalog ?? null,
            log: mergeLog(report.log, raw, sanitized),
          };
        },
        newId: () => attemptId,
        onInvalidate: (testing) => {
          if (shouldApplyAttempt(attemptRef.current, testing.attemptId)) setScan(testing);
        },
      });
      if (!shouldApplyAttempt(attemptRef.current, out.attemptId)) return;
      if (mode === "refresh") {
        setScan(out.result);
        const live = currentConnectionView(out.result.lastTestOk, out.result.catalog);
        setMsg(
          out.result.status === "CONNECTED"
            ? `CONNECTED. ${live.available} AVAILABLE · ${out.result.catalog?.recommendedIds.length ?? 0} recommended.`
            : out.result.error || "Connection failed.",
        );
        await save({
          ...persistBase,
          members: membersFromIds(out.result.selectedIds, out.result.catalog?.models ?? []),
          ...persistScanFields(out.result),
        });
        return;
      }
      setMsg("Verifying selected models and billing completion…");
      const accepted = await runSaveAcceptance({
        attemptId: out.attemptId,
        previous,
        persisted,
        expected: { provider, nanogptBilling: config.nanogptBilling },
        report: {
          ok: out.result.lastTestOk === true && Boolean(out.result.catalog),
          error: out.result.error ?? undefined,
          catalog: out.result.catalog,
          log: out.result.log,
        },
        verifySelected: async (ids) => {
          const checked = await checkAccess({
            provider,
            apiKey: sanitized,
            models: ids,
            nanogptBilling: config.nanogptBilling,
          });
          return { ok: checked.ok, blocked: checked.blocked, error: checked.error };
        },
        completionProbe: async (args) => {
          const ping = await completeChat({
            provider: args.provider,
            apiKey: sanitized,
            model: args.model,
            messages: [{ role: "user", content: "ping" }],
            maxTokens: 1,
            temperature: 0,
            nanogptBilling: args.nanogptBilling,
          });
          return { ok: ping.ok, error: ping.ok ? undefined : ping.error, model: args.model };
        },
        persistResult: async (attempt) => {
          await save({
            ...persistBase,
            members: membersFromIds(attempt.selectedIds, attempt.catalog?.models ?? previous.catalog?.models ?? []),
            ...persistScanFields(attempt),
          });
        },
        reload: () => refreshAccountSettings(),
      });
      if (!shouldApplyAttempt(attemptRef.current, out.attemptId)) return;
      setScan(accepted.result);
      if (accepted.reloaded && accepted.result.status === "CONNECTED") {
        hydrateFromAccount(accepted.reloaded);
      }
      setMsg(
        accepted.result.status === "CONNECTED"
          ? `CONNECTED. Persist, catalog, probe, ${accepted.result.selectedIds.length} VERIFIED_AVAILABLE, billing completion, and reload passed.`
          : accepted.result.error || "Connection failed.",
      );
      if (sanitized && accepted.result.status === "CONNECTED") setApiKey("");
    } catch (err) {
      if (!shouldApplyAttempt(attemptRef.current, attemptId)) return;
      const text = err instanceof Error ? err.message : "Connection failed.";
      const failed = applyDiscovery({
        attemptId,
        report: {
          ok: false,
          error: text,
          log: localFailLog(text, raw, sanitized, { client_exception: text }),
        },
        previousIds: previous.selectedIds,
        previousSynth: previous.synthesizerModel,
        previousCatalog: previous.catalog,
      });
      setScan(failed);
      setMsg(text);
      try {
        await save({ ...persistBase, ...persistScanFields(failed) });
      } catch {
        /* on-screen state is already FAILED for this attempt */
      }
    } finally {
      if (shouldApplyAttempt(attemptRef.current, attemptId)) {
        scanningRef.current = false;
        setBusy(false);
      }
    }
  }

  async function onClear() {
    try {
      scanningRef.current = false;
      await clearKey();
      setApiKey("");
      setScan(emptyScan());
      setMsg(`${meta.name} key removed from this account.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not clear the key.");
    }
  }

  const logResult =
    /\n {2}"result": "PASS"/.test(scan.log) || scan.log.includes('"result": "PASS"')
      ? "PASS"
      : scan.log
        ? "FAIL"
        : "";
  const statusOk = statusLabel === "CONNECTED" ? true : statusLabel === "FAILED" ? false : undefined;

  return (
    <Page>
      <PageHeader title="API Settings">
        <p className="max-w-measure text-muted">
          NanoGPT and OpenRouter are API providers, not Council members. Refresh models discovers the catalog. Save
          reports CONNECTED only after persist, catalog, an authenticated probe, every selected model is
          VERIFIED_AVAILABLE, one billing-mode completion, and a reload that still shows CONNECTED. A failed stage is
          named in the status. Council never mixes Subscription with Pay-as-you-go.
        </p>
      </PageHeader>

      <Panel>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void runCanonicalDiscovery("save");
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="text-xs font-semibold tracking-widest text-muted uppercase">API provider</legend>
            <div className="flex flex-wrap gap-2">
              {PROVIDER_IDS.map((id) => {
                const selected = id === provider;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSwitch(id)}
                    className={`min-h-11 rounded-sm px-3.5 py-2.5 font-semibold ${
                      selected
                        ? "border border-accent bg-accent text-accent-fg"
                        : "border border-line bg-transparent text-fg"
                    }`}
                  >
                    {PROVIDERS[id].name}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {provider === "nanogpt" ? (
            <fieldset className="grid gap-2">
              <legend className="text-xs font-semibold tracking-widest text-muted uppercase">NanoGPT billing</legend>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["subscription", "Subscription"],
                    ["payg", "Pay-as-you-go"],
                  ] as const
                ).map(([id, label]) => {
                  const selected = config.nanogptBilling === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onBilling(id)}
                      className={`min-h-11 rounded-sm px-3.5 py-2.5 font-semibold ${
                        selected
                          ? "border border-accent bg-accent text-accent-fg"
                          : "border border-line bg-transparent text-fg"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="m-0 max-w-measure text-sm text-muted">
                Subscription uses the subscription catalog and{" "}
                <span className="font-mono text-xs">/api/subscription/v1/chat/completions</span>. Pay-as-you-go uses the
                generic catalog only when you select it. Council never falls back.
              </p>
            </fieldset>
          ) : null}
          <Field label={`${meta.name} key`}>
            <div className="flex flex-wrap gap-2">
              <TextInput
                type={showKey ? "text" : "password"}
                name={`${provider}-api-key`}
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                placeholder={meta.placeholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onPaste={onPaste}
                className="min-w-0 flex-1"
              />
              <button
                type="button"
                className="min-h-11 rounded-sm border border-line bg-transparent px-3.5 font-semibold text-fg"
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </Field>
          {keyHint.text ? <p className={keyHint.ok ? "text-ok" : "text-danger"}>{keyHint.text}</p> : null}
          {savedSlot.saved ? (
            <p className="text-ok">
              Saved on this account: {savedSlot.masked || meta.keyPrefix}. Paste a new key only if you want to replace
              it.
            </p>
          ) : null}
          <p className="max-w-measure text-muted">
            Create a key at{" "}
            <a href={meta.keysUrl} className="text-fg underline" target="_blank" rel="noreferrer">
              {meta.keysUrl.replace("https://", "")}
            </a>
            . {meta.help} Switching provider clears the previous scan and never mixes providers inside one Council run.
          </p>
          <div className="flex flex-wrap gap-3">
            <PrimaryButton type="button" disabled={busy} onClick={() => void runCanonicalDiscovery("refresh")}>
              {scan.catalog ? "Refresh models" : "Test Connection"}
            </PrimaryButton>
            <PrimaryButton type="submit" disabled={busy}>
              Save
            </PrimaryButton>
            <button
              type="button"
              className="min-h-11 rounded-sm border border-danger bg-transparent px-3.5 py-2.5 font-semibold text-danger"
              onClick={() => void onClear()}
            >
              Clear Key
            </button>
          </div>
        </form>
      </Panel>

      <Panel>
        <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Connection status</p>
        <h2 className="font-display mt-0 mb-4 text-xl">{meta.name}</h2>
        <dl className="m-0 grid gap-3 sm:grid-cols-2">
          <StatusRow label="Provider" value={meta.name} />
          {provider === "nanogpt" ? (
            <StatusRow label="Billing" value={billingLabel(config.nanogptBilling)} />
          ) : null}
          <StatusRow label="Status" value={statusLabel} ok={statusOk} />
          <StatusRow label="Last tested" value={lastTested} />
          {provider === "nanogpt" && config.nanogptBilling === "subscription" ? (
            <StatusRow label="Subscription models" value={String(view.discovered)} />
          ) : (
            <StatusRow label="Models discovered" value={String(view.discovered)} />
          )}
          <StatusRow label="Selected Council" value={String(scan.selectedIds.length)} />
          <StatusRow label="Models available" value={String(view.available)} />
        </dl>
        {view.stale ? (
          <p className="mt-4 mb-0 text-sm text-warn">
            STALE cached catalog from a previous scan ({view.stale.models.length} models,{" "}
            {view.stale.recommendedIds.length} recommended). Not current results.
          </p>
        ) : null}
        {msg ? <p className="mt-4 mb-0 text-muted">{msg}</p> : null}
      </Panel>

      <Panel>
        <ModelCatalogPanel
          catalog={liveCatalog ?? view.stale}
          stale={Boolean(view.stale)}
          selectedIds={scan.selectedIds}
          synthesizerModel={scan.synthesizerModel}
          query={query}
          onQuery={setQuery}
          onToggle={(id) => {
            if (view.stale) return;
            const row = liveCatalog?.models.find((item) => item.id === id);
            if (row && row.access !== "AVAILABLE") return;
            setScan((prev) => {
              const selectedIds = prev.selectedIds.includes(id)
                ? prev.selectedIds.filter((item) => item !== id)
                : prev.selectedIds.length >= MAX_COUNCIL_MEMBERS
                  ? prev.selectedIds
                  : [...prev.selectedIds, id];
              return {
                ...prev,
                selectedIds,
                synthesizerModel: selectedIds.includes(prev.synthesizerModel) ? prev.synthesizerModel : "",
              };
            });
          }}
          onSynthesizer={(id) => setScan((prev) => ({ ...prev, synthesizerModel: id }))}
        />
      </Panel>

      <Panel>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Council recommendation</p>
            <h2 className="font-display m-0 text-xl">Selected AVAILABLE models only</h2>
          </div>
          <button
            type="button"
            className="min-h-11 rounded-sm border border-line bg-transparent px-3.5 font-semibold text-fg"
            disabled={!liveCatalog?.recommendedIds.length}
            onClick={() => {
              if (!liveCatalog) return;
              const selectedIds = liveCatalog.recommendedIds.slice(0, MAX_COUNCIL_MEMBERS);
              setScan((prev) => ({ ...prev, selectedIds, synthesizerModel: "" }));
            }}
          >
            Accept recommended
          </button>
        </div>
        {members.length ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {members.map((row) => (
              <li key={row.modelId} className="text-sm">
                <span className="text-fg">{row.role.replaceAll("_", " ")}</span>
                <span className="text-muted"> · {row.label}</span>
                <span className="block font-mono text-xs break-all text-faint">{row.modelId}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-muted">No Council yet. Test Connection, then accept the AVAILABLE recommendation or tick models.</p>
        )}
        {selectionError ? <p className="mt-3 mb-0 text-danger">{selectionError}</p> : null}
        <p className="mt-3 mb-0 max-w-measure text-sm text-muted">
          Cost is telemetry only. A Council of {members.length || "N"} models expects {expected} successful calls and
          stops at {limit} provider attempts.
        </p>
      </Panel>

      <OpLogPanel
        title={logResult ? `Test log · ${logResult}` : "Test log"}
        hint="Copy log works for PASS and FAIL. The API secret is never included. The latest log is kept after reload. A failed Save names the exact stage."
        value={scan.log}
        empty="Run Test Connection to capture a detailed log."
      />
      <SystemInfoPanel />
    </Page>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs font-semibold tracking-widest text-muted uppercase">{label}</dt>
      <dd className={`m-0 font-mono text-sm ${ok === true ? "text-ok" : ok === false ? "text-danger" : "text-fg"}`}>
        {value}
      </dd>
    </div>
  );
}

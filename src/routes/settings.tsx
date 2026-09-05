import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ClipboardEvent } from "react";
import { Field, Page, PageHeader, Panel, PrimaryButton, TextInput } from "@/components/council-ui";
import { ModelCatalogPanel } from "@/components/model-catalog";
import { OpLogPanel } from "@/components/op-log";
import { SystemInfoPanel } from "@/components/system-info";
import { describeKey, keyFingerprint, redact, sanitizeApiKey } from "@/lib/council/api-key";
import { currentConnectionView, pruneToAvailable } from "@/lib/council/discover";
import { emptyAccessCounts, formatTestLog } from "@/lib/council/test-log";
import { assertAvailableSelection, MAX_COUNCIL_MEMBERS, attemptLimit, expectedSuccessfulCalls, membersFromIds } from "@/lib/council/members";
import { testProvider } from "@/lib/council/openrouter";
import { PROVIDER_IDS, PROVIDERS, slotFor } from "@/lib/council/providers";
import { useSession } from "@/lib/council/session";
import type { DiscoverySnapshot, ProviderId } from "@/lib/council/types";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const { config, save, clearKey, setProvider } = useSession();
  const navigate = useNavigate();
  const provider = config.provider;
  const meta = PROVIDERS[provider];
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>(config.selectedModelIds);
  const [synthesizerModel, setSynthesizerModel] = useState(config.synthesizerModel);
  const [catalog, setCatalog] = useState<DiscoverySnapshot | null>(config.catalog);
  const [lastTestOk, setLastTestOk] = useState<boolean | null>(config.lastTestOk);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState(config.lastTestLog);
  const keyHint = useMemo(() => describeKey(apiKey, provider), [apiKey, provider]);
  const savedSlot = slotFor(config, provider);
  const view = currentConnectionView(lastTestOk, catalog);
  const liveCatalog = view.catalog;
  const members = membersFromIds(selectedIds, liveCatalog?.models ?? []);
  const expected = expectedSuccessfulCalls(members.length || 2);
  const limit = attemptLimit(members.length || 2);
  const selectionError = liveCatalog
    ? assertAvailableSelection(selectedIds, liveCatalog.models)
    : "Test Connection before saving Council models. Only AVAILABLE models from the current scan can be saved.";
  const lastTested = config.lastTestAt
    ? new Date(config.lastTestAt).toLocaleString()
    : liveCatalog?.fetchedAt
      ? new Date(liveCatalog.fetchedAt).toLocaleString()
      : "Never";

  useEffect(() => {
    setSelectedIds(config.selectedModelIds);
    setSynthesizerModel(config.synthesizerModel);
    setCatalog(config.catalog);
    setLastTestOk(config.lastTestOk);
    if (config.lastTestLog) setLog(config.lastTestLog);
  }, [
    config.provider,
    config.selectedModelIds,
    config.synthesizerModel,
    config.catalog,
    config.lastTestLog,
    config.lastTestOk,
  ]);

  function creds() {
    return {
      provider,
      apiKey: sanitizeApiKey(apiKey, provider) || (savedSlot.saved ? "" : ""),
      members,
      synthesizerModel,
      maxCostUsd: config.maxCostUsd > 0 ? config.maxCostUsd : 1,
      selectedModelIds: selectedIds,
      catalog: liveCatalog,
    };
  }

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
    setProvider(next);
    setApiKey("");
    setShowKey(false);
    setLog("");
    setMsg("");
    setQuery("");
    setCatalog(null);
    setLastTestOk(null);
    setSelectedIds([]);
    setSynthesizerModel("");
  }

  function applyCatalog(next: DiscoverySnapshot, previousIds: string[]) {
    setCatalog(next);
    const keep = pruneToAvailable(previousIds, next.models);
    const pick = keep.length >= 2 ? keep : next.recommendedIds.slice(0, MAX_COUNCIL_MEMBERS);
    setSelectedIds(pick);
    setSynthesizerModel((current) => (pick.includes(current) ? current : ""));
    return pick;
  }

  async function persistScan(opts: {
    logText: string;
    ok: boolean;
    nextCatalog: DiscoverySnapshot | null;
    nextIds: string[];
    synth: string;
  }) {
    try {
      await save({
        ...creds(),
        selectedModelIds: opts.nextIds,
        synthesizerModel: opts.synth,
        catalog: opts.nextCatalog,
        lastTestLog: opts.logText,
        lastTestAt: new Date().toISOString(),
        lastTestOk: opts.ok,
      });
    } catch {
      /* log is already on screen */
    }
  }

  async function failAttempt(reason: string, raw: string, sanitized: string, extra?: Record<string, unknown>) {
    const logText = extra ? localFailLog(reason, raw, sanitized, extra) : localFailLog(reason, raw, sanitized);
    setMsg(reason);
    setLog(logText);
    setLastTestOk(false);
    await persistScan({
      logText,
      ok: false,
      nextCatalog: catalog,
      nextIds: selectedIds,
      synth: synthesizerModel,
    });
    return false;
  }

  async function runProbe() {
    const raw = apiKey;
    const body = creds();
    if (!body.apiKey && !savedSlot.saved) {
      return failAttempt("Paste your API key first.", raw, "");
    }
    if (body.apiKey) {
      const hint = describeKey(body.apiKey, provider);
      if (!hint.ok) return failAttempt(hint.text, raw, body.apiKey);
    }
    setBusy(true);
    setMsg("Discovering models and checking account access…");
    try {
      const report = await testProvider(body);
      const logText = mergeLog(report.log, raw, body.apiKey);
      setLog(logText);
      if (report.ok && report.catalog) {
        const nextIds = applyCatalog(report.catalog, selectedIds);
        setLastTestOk(true);
        setMsg(
          `CONNECTED. ${currentConnectionView(true, report.catalog).available} AVAILABLE · ${report.catalog.recommendedIds.length} recommended.`,
        );
        await persistScan({
          logText,
          ok: true,
          nextCatalog: report.catalog,
          nextIds,
          synth: nextIds.includes(synthesizerModel) ? synthesizerModel : "",
        });
        return true;
      }
      setLastTestOk(false);
      setMsg(report.error || "Connection failed.");
      await persistScan({
        logText,
        ok: false,
        nextCatalog: catalog,
        nextIds: selectedIds,
        synth: synthesizerModel,
      });
      return false;
    } catch (err) {
      const text = err instanceof Error ? err.message : "Connection failed.";
      await failAttempt(text, raw, body.apiKey, {
        client_exception: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    if (selectionError) {
      setMsg(selectionError);
      if (!log) setLog(localFailLog(selectionError, apiKey, sanitizeApiKey(apiKey, provider)));
      return;
    }
    const raw = apiKey;
    const body = creds();
    if (!body.apiKey && !savedSlot.saved) {
      await failAttempt("Paste your API key first.", raw, "");
      return;
    }
    let tested = lastTestOk === true && Boolean(liveCatalog);
    if (body.apiKey || !tested) {
      tested = await runProbe();
    }
    if (!tested) return;
    setBusy(true);
    try {
      await save({
        ...creds(),
        lastTestLog: log,
        lastTestAt: config.lastTestAt ?? new Date().toISOString(),
        lastTestOk: true,
      });
      setApiKey("");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not save to this account.");
      setBusy(false);
      return;
    }
    setBusy(false);
    setMsg(`${meta.name} is saved on this account.`);
    void navigate({ to: "/" });
  }

  async function onClear() {
    try {
      await clearKey();
      setApiKey("");
      setMsg(`${meta.name} key removed from this account.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not clear the key.");
    }
  }

  const logResult = /\n {2}"result": "PASS"/.test(log) || log.includes('"result": "PASS"') ? "PASS" : log ? "FAIL" : "";
  const statusOk = view.status === "CONNECTED" ? true : view.status === "FAILED" ? false : undefined;

  return (
    <Page>
      <PageHeader title="API Settings">
        <p className="max-w-measure text-muted">
          NanoGPT and OpenRouter are API providers, not Council members. Test Connection discovers models this key can
          actually call. Only AVAILABLE models can join the Council.
        </p>
      </PageHeader>

      <Panel>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
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
            <PrimaryButton type="button" disabled={busy} onClick={() => void runProbe()}>
              {catalog ? "Refresh models" : "Test Connection"}
            </PrimaryButton>
            <PrimaryButton type="submit" disabled={busy || Boolean(selectionError)}>
              Save
            </PrimaryButton>
            <button
              type="button"
              className="min-h-11 rounded-sm border border-danger bg-transparent px-3.5 py-2.5 font-semibold text-danger"
              onClick={onClear}
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
          <StatusRow label="Status" value={view.status} ok={statusOk} />
          <StatusRow label="Last tested" value={lastTested} />
          <StatusRow label="Models discovered" value={String(view.discovered)} />
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
          selectedIds={selectedIds}
          synthesizerModel={synthesizerModel}
          query={query}
          onQuery={setQuery}
          onToggle={(id) => {
            if (view.stale) return;
            const row = liveCatalog?.models.find((item) => item.id === id);
            if (row && row.access !== "AVAILABLE") return;
            setSelectedIds((prev) => {
              if (prev.includes(id)) {
                const next = prev.filter((item) => item !== id);
                if (synthesizerModel === id) setSynthesizerModel("");
                return next;
              }
              if (prev.length >= MAX_COUNCIL_MEMBERS) return prev;
              return [...prev, id];
            });
          }}
          onSynthesizer={setSynthesizerModel}
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
              setSelectedIds(liveCatalog.recommendedIds.slice(0, MAX_COUNCIL_MEMBERS));
              setSynthesizerModel("");
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
        hint="Copy log works for PASS and FAIL. The API secret is never included. The latest log is kept after reload."
        value={log}
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

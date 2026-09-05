import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, X } from "lucide-react";
import { useEffect, useMemo, useState, type ClipboardEvent } from "react";
import { Field, Page, PageHeader, Panel, PrimaryButton, TextInput } from "@/components/council-ui";
import { ModelCatalogPanel } from "@/components/model-catalog";
import { OpLogPanel } from "@/components/op-log";
import { SystemInfoPanel } from "@/components/system-info";
import { describeKey, keyFingerprint, sanitizeApiKey } from "@/lib/council/api-key";
import { accessBlocksRun } from "@/lib/council/discover";
import { assertCouncilSelection, MAX_COUNCIL_MEMBERS, attemptLimit, expectedSuccessfulCalls, membersFromIds } from "@/lib/council/members";
import { testProvider } from "@/lib/council/openrouter";
import { PROVIDER_IDS, PROVIDERS, slotFor } from "@/lib/council/providers";
import { useSession } from "@/lib/council/session";
import type { ConnectionCheck, DiscoverySnapshot, ProviderId } from "@/lib/council/types";

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
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState("");
  const [checks, setChecks] = useState<Record<string, ConnectionCheck> | null>(null);
  const keyHint = useMemo(() => describeKey(apiKey, provider), [apiKey, provider]);
  const savedSlot = slotFor(config, provider);
  const members = membersFromIds(selectedIds, catalog?.models ?? []);
  const expected = expectedSuccessfulCalls(members.length || 3);
  const limit = attemptLimit(members.length || 3);
  const selectionError = assertCouncilSelection(selectedIds);
  const blocked = selectedIds.filter((id) => {
    const row = catalog?.models.find((item) => item.id === id);
    return row ? accessBlocksRun(row.access) : Boolean(catalog);
  });

  useEffect(() => {
    setSelectedIds(config.selectedModelIds);
    setSynthesizerModel(config.synthesizerModel);
    setCatalog(config.catalog);
  }, [config.provider, config.selectedModelIds, config.synthesizerModel, config.catalog]);

  function creds() {
    return {
      provider,
      apiKey: sanitizeApiKey(apiKey, provider) || (savedSlot.saved ? "" : ""),
      members,
      synthesizerModel,
      maxCostUsd: config.maxCostUsd > 0 ? config.maxCostUsd : 1,
      selectedModelIds: selectedIds,
      catalog,
    };
  }

  function clientMeta(raw: string, sanitized: string) {
    const hint = describeKey(raw || sanitized, provider);
    const fp = keyFingerprint(sanitized, provider);
    return {
      pasted_chars: raw.length,
      sanitized_chars: sanitized.length,
      key_prefix: fp.prefix,
      local_describe: hint.text || "(empty)",
    };
  }

  function pretty(value: unknown) {
    return JSON.stringify(value, null, 2);
  }

  function mergeLog(serverLog: string, raw: string, sanitized: string) {
    try {
      const data = JSON.parse(serverLog) as Record<string, unknown>;
      data.client = clientMeta(raw, sanitized);
      return pretty(data);
    } catch {
      return pretty({
        title: "Conversation Bot · API test log",
        result: "FAIL",
        time: new Date().toISOString(),
        probe: "server",
        provider,
        client: clientMeta(raw, sanitized),
        raw_log: serverLog,
        note: "The API secret is not included in this log.",
      });
    }
  }

  function localFailLog(reason: string, raw: string, sanitized: string, extra?: Record<string, unknown>) {
    return pretty({
      title: "Conversation Bot · API test log",
      result: "FAIL",
      time: new Date().toISOString(),
      probe: "local (request not sent)",
      provider,
      client: clientMeta(raw, sanitized),
      error: reason,
      ...extra,
      note: "The API secret is not included in this log.",
    });
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
    setChecks(null);
    setLog("");
    setMsg("");
    setQuery("");
    setCatalog(null);
    setSelectedIds([]);
    setSynthesizerModel("");
  }

  function applyCatalog(next: DiscoverySnapshot | null) {
    setCatalog(next);
    if (!next) return;
    const usable = next.models.filter((row) => !accessBlocksRun(row.access));
    const keep = selectedIds.filter((id) => usable.some((row) => row.id === id));
    const pick = keep.length >= 2 ? keep : next.recommendedIds.slice(0, MAX_COUNCIL_MEMBERS);
    setSelectedIds(pick);
    if (synthesizerModel && !pick.includes(synthesizerModel)) setSynthesizerModel("");
  }

  function onToggle(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((item) => item !== id);
        if (synthesizerModel === id) setSynthesizerModel("");
        return next;
      }
      if (prev.length >= MAX_COUNCIL_MEMBERS) return prev;
      return [...prev, id];
    });
  }

  async function runProbe(kind: "test" | "save") {
    const raw = apiKey;
    const body = creds();
    if (!body.apiKey && !savedSlot.saved) {
      const text = "Paste your API key first.";
      setMsg(text);
      setLog(localFailLog(text, raw, ""));
      return false;
    }
    if (body.apiKey) {
      const hint = describeKey(body.apiKey, provider);
      if (!hint.ok) {
        setMsg(hint.text);
        setLog(localFailLog(hint.text, raw, body.apiKey));
        return false;
      }
    }
    setBusy(true);
    setMsg(kind === "save" ? "Saving…" : "Discovering models and checking account access…");
    try {
      const report = await testProvider(body);
      setChecks(report.checks);
      setLog(mergeLog(report.log, raw, body.apiKey));
      if (report.catalog) applyCatalog(report.catalog);
      setMsg(
        report.ok
          ? `Connected. ${report.catalog?.recommendedIds.length ?? 0} models recommended.`
          : report.error || "Connection failed.",
      );
      return report.ok;
    } catch (err) {
      const text = err instanceof Error ? err.message : "Connection failed.";
      setMsg(text);
      setLog(
        localFailLog(text, raw, body.apiKey, {
          client_exception: err instanceof Error ? err.stack || err.message : String(err),
        }),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    await runProbe("test");
  }

  async function onSave() {
    const raw = apiKey;
    const body = creds();
    if (!body.apiKey && !savedSlot.saved) {
      const text = "Paste your API key first.";
      setMsg(text);
      setLog(localFailLog(text, raw, ""));
      return;
    }
    if (selectionError) {
      setMsg(selectionError);
      return;
    }
    let tested = true;
    if (body.apiKey || !catalog) {
      tested = await runProbe("test");
    }
    setBusy(true);
    try {
      await save(creds());
      setApiKey("");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not save to this account.");
      setBusy(false);
      return;
    }
    setBusy(false);
    if (tested) {
      setMsg(`${meta.name} is saved on this account.`);
      void navigate({ to: "/" });
      return;
    }
    setMsg(`${meta.name} is saved on this account, but the connection test failed.`);
  }

  async function onClear() {
    try {
      await clearKey();
      setApiKey("");
      setChecks(null);
      setLog("");
      setMsg(`${meta.name} key removed from this account.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not clear the key.");
    }
  }

  return (
    <Page>
      <PageHeader title="API Settings">
        <p className="max-w-measure text-muted">
          Keys stay on this signed-in account. Test Connection discovers models this key can actually call, then you
          pick 2–5 Council members. The full secret is never shown again after save.
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
            <legend className="text-sm font-medium text-muted">API Provider</legend>
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
          {keyHint.text ? (
            <p className={keyHint.ok ? "text-ok" : "text-danger"}>{keyHint.text}</p>
          ) : null}
          {savedSlot.saved ? (
            <p className="text-ok">
              Saved on this account: {savedSlot.masked || meta.keyPrefix}. Paste a new key only if you want to
              replace it.
            </p>
          ) : null}
          <p className="max-w-measure text-muted">
            Create a key at{" "}
            <a href={meta.keysUrl} className="text-fg underline" target="_blank" rel="noreferrer">
              {meta.keysUrl.replace("https://", "")}
            </a>
            . {meta.help} Switching provider re-runs discovery and never mixes providers inside one Council run.
          </p>
          <ModelCatalogPanel
            catalog={catalog}
            selectedIds={selectedIds}
            synthesizerModel={synthesizerModel}
            query={query}
            onQuery={setQuery}
            onToggle={onToggle}
            onAcceptRecommended={() => {
              if (!catalog) return;
              setSelectedIds(catalog.recommendedIds.slice(0, MAX_COUNCIL_MEMBERS));
              setSynthesizerModel("");
            }}
            onSynthesizer={setSynthesizerModel}
          />
          {selectionError ? <p className="text-danger">{selectionError}</p> : null}
          {blocked.length ? (
            <p className="text-danger">
              MODEL_UNAVAILABLE: {blocked.join(", ")}. Refresh models and pick a replacement.
            </p>
          ) : null}
          {members.length ? (
            <ul className="m-0 grid list-none gap-1 p-0 text-sm">
              {members.map((row) => (
                <li key={row.modelId} className="text-muted">
                  <span className="text-fg">{row.role.replaceAll("_", " ")}</span> · {row.label}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="max-w-measure text-muted">
            Cost is telemetry only. A Council of {members.length || "N"} models expects {expected} successful calls
            and stops at {limit} provider attempts, including retries. Empty responses are failures, not success.
          </p>
          <div className="flex flex-wrap gap-3">
            <PrimaryButton type="button" disabled={busy} onClick={() => void onTest()}>
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
        <section className="mt-6 grid gap-2">
          <h2 className="font-display text-lg">Connection Status</h2>
          {Object.entries(checks ?? { [provider]: { ok: false, label: meta.name, detail: "—" } }).map(([key, row]) => (
            <p key={key} className="flex items-center justify-between gap-3 text-sm">
              <span>{row.label}</span>
              <span
                className={`inline-flex max-w-measure items-center gap-1.5 text-right ${
                  row.ok ? "text-ok" : checks ? "text-danger" : "text-muted"
                }`}
              >
                {checks ? (
                  row.ok ? (
                    <Check className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <X className="size-4 shrink-0" aria-hidden="true" />
                  )
                ) : null}
                {row.detail}
              </span>
            </p>
          ))}
        </section>
        {msg ? <p className="mt-3 text-muted">{msg}</p> : null}
      </Panel>

      <OpLogPanel
        title="Test log"
        hint="Copy this after Test Connection and send it if the key fails. The secret itself is never included."
        value={log}
        empty="Run Test Connection to capture a detailed log."
      />
      <SystemInfoPanel />
    </Page>
  );
}

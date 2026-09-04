import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, X } from "lucide-react";
import { useEffect, useMemo, useState, type ClipboardEvent } from "react";
import { Field, Page, PageHeader, Panel, PrimaryButton, TextInput } from "@/components/council-ui";
import { OpLogPanel } from "@/components/op-log";
import { SystemInfoPanel } from "@/components/system-info";
import { describeKey, keyFingerprint, sanitizeApiKey } from "@/lib/council/api-key";
import { testProvider } from "@/lib/council/openrouter";
import { PROVIDER_IDS, PROVIDERS } from "@/lib/council/providers";
import { useSession } from "@/lib/council/session";
import type { ConnectionCheck, ProviderId } from "@/lib/council/types";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const { config, save, clearKey, setProvider } = useSession();
  const navigate = useNavigate();
  const provider = config.provider;
  const meta = PROVIDERS[provider];
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [gptModel, setGptModel] = useState(config.gptModel);
  const [grokModel, setGrokModel] = useState(config.grokModel);
  const [claudeModel, setClaudeModel] = useState(config.claudeModel);
  const [maxCostUsd, setMaxCostUsd] = useState(String(config.maxCostUsd));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState("");
  const [checks, setChecks] = useState<Record<string, ConnectionCheck> | null>(null);
  const keyHint = useMemo(() => describeKey(apiKey, provider), [apiKey, provider]);
  const savedSlot = provider === "openrusrouter" ? config.openrusrouter : config.openrouter;
  const checkOrder = [provider, "gpt", "grok", "claude"] as const;

  useEffect(() => {
    setGptModel(config.gptModel);
    setGrokModel(config.grokModel);
    setClaudeModel(config.claudeModel);
    setMaxCostUsd(String(config.maxCostUsd));
  }, [config.gptModel, config.grokModel, config.claudeModel, config.maxCostUsd]);

  function creds() {
    return {
      provider,
      apiKey: sanitizeApiKey(apiKey, provider) || (savedSlot.saved ? "" : ""),
      gptModel,
      grokModel,
      claudeModel,
      maxCostUsd: Number(maxCostUsd) > 0 ? Number(maxCostUsd) : 1,
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
    setMsg(kind === "save" ? "Saving…" : "Testing GPT, Grok, and Claude…");
    try {
      const report = await testProvider(body);
      setChecks(report.checks);
      setLog(mergeLog(report.log, raw, body.apiKey));
      setMsg(report.ok ? "All three models are ready." : report.error || "Connection failed.");
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
    let tested = true;
    if (body.apiKey) {
      tested = await runProbe("test");
    }
    setBusy(true);
    try {
      await save(body);
      setApiKey("");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not save to this account.");
      setBusy(false);
      return;
    }
    setBusy(false);
    const savedCopy = meta.id === "openrouter" ? "The API key" : meta.name;
    if (tested) {
      setMsg(`${savedCopy} is saved on this account.`);
      void navigate({ to: "/" });
      return;
    }
    setMsg(`${savedCopy} is saved on this account, but the connection test failed.`);
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
          Keys are stored on this signed-in account, not in the browser. Test GPT, Grok, and Claude, then Save.
          A new device can use the key after you sign in. The full secret is never shown again after save.
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
            <legend className="text-sm font-medium text-muted">Provider</legend>
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
            . {meta.help}
          </p>
          <Field label="GPT Architect Model">
            <TextInput value={gptModel} onChange={(e) => setGptModel(e.target.value)} />
          </Field>
          <Field label="Grok Adversary Model">
            <TextInput value={grokModel} onChange={(e) => setGrokModel(e.target.value)} />
          </Field>
          <Field label="Claude Formalist Model">
            <TextInput value={claudeModel} onChange={(e) => setClaudeModel(e.target.value)} />
          </Field>
          <Field label="Maximum cost per Council run (USD)">
            <TextInput
              type="number"
              min={0.01}
              step={0.01}
              value={maxCostUsd}
              onChange={(e) => setMaxCostUsd(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-3">
            <PrimaryButton type="button" disabled={busy} onClick={() => void onTest()}>
              Test Connection
            </PrimaryButton>
            <PrimaryButton type="submit" disabled={busy}>
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
          {checkOrder.map((key) => {
            const row = checks?.[key];
            return (
              <p key={key} className="flex items-center justify-between gap-3 text-sm">
                <span>{row?.label ?? labelFor(key)}</span>
                <span
                  className={`inline-flex max-w-measure items-center gap-1.5 text-right ${
                    row?.ok ? "text-ok" : row ? "text-danger" : "text-muted"
                  }`}
                >
                  {row ? (
                    row.ok ? (
                      <Check className="size-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <X className="size-4 shrink-0" aria-hidden="true" />
                    )
                  ) : null}
                  {row ? row.detail : "—"}
                </span>
              </p>
            );
          })}
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

function labelFor(key: string): string {
  if (key === "openrouter") return "API";
  if (key === "openrusrouter") return "OpenRusRouter";
  if (key === "gpt") return "GPT Architect";
  if (key === "grok") return "Grok Adversary";
  return "Claude Formalist";
}

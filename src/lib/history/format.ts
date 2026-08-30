import type { AccessStatus, ChatProvider, ImportMethod, ImportStatus } from "./types.ts";
import { ACCESS_COPY } from "./access.ts";
import { HISTORY_NOT_CANONICAL, PRIVACY_NOTE } from "./provenance.ts";

export { ACCESS_COPY, HISTORY_NOT_CANONICAL, PRIVACY_NOTE };

export const PROVIDER_LABEL: Record<ChatProvider, string> = {
  CHATGPT: "ChatGPT",
  GROK: "Grok",
  GROK_BUILD: "Grok Build",
  CLAUDE: "Claude",
  UNKNOWN: "Unknown",
};

export const METHOD_LABEL: Record<ImportMethod, string> = {
  URL: "URL",
  FILE: "Upload",
  PASTE: "Paste",
};

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export function formatChars(count: number): string {
  if (count < 1000) return `${count} chars`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k chars`;
  return `${(count / 1_000_000).toFixed(2)} MB text`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count} tokens`;
  const k = count / 1000;
  if (k < 10) return `${k.toFixed(1).replace(/\.0$/, "")}k tokens`;
  return `${Math.round(k)}k tokens`;
}

export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function accessLabel(status: AccessStatus): string {
  return status.replaceAll("_", " ");
}

export function importLabel(status: ImportStatus): string {
  return status.replaceAll("_", " ");
}

export const PROVIDERS: ChatProvider[] = ["CHATGPT", "GROK", "GROK_BUILD", "CLAUDE", "UNKNOWN"];

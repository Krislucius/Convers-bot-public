import { Check } from "lucide-react";
import { ROLE_LABEL, type CouncilRole } from "@/lib/council/roles";
import { MAX_COUNCIL_MEMBERS } from "@/lib/council/members";
import { availableModels, type DiscoveredModel, type DiscoverySnapshot, type ModelAccess } from "@/lib/council/discover";

const ACCESS_CLASS: Record<ModelAccess, string> = {
  AVAILABLE: "text-ok",
  UNKNOWN: "text-muted",
  NOT_INCLUDED: "text-warn",
  UNAVAILABLE: "text-danger",
};

const ACCESS_LABEL: Record<ModelAccess, string> = {
  AVAILABLE: "AVAILABLE",
  UNKNOWN: "UNKNOWN",
  NOT_INCLUDED: "NOT INCLUDED",
  UNAVAILABLE: "UNAVAILABLE",
};

export function ModelCatalogPanel({
  catalog,
  selectedIds,
  synthesizerModel,
  query,
  onQuery,
  onToggle,
  onSynthesizer,
}: {
  catalog: DiscoverySnapshot | null;
  selectedIds: string[];
  synthesizerModel: string;
  query: string;
  onQuery: (value: string) => void;
  onToggle: (id: string) => void;
  onSynthesizer: (id: string) => void;
}) {
  if (!catalog) {
    return (
      <p className="m-0 max-w-measure text-muted">
        Test Connection fetches this provider's catalog and probes whether the account can actually call those
        models. Only AVAILABLE models can join the Council.
      </p>
    );
  }

  const needle = query.trim().toLowerCase();
  const selected = new Set(selectedIds);
  const available = availableModels(catalog.models);
  const others = catalog.models.filter((row) => row.access !== "AVAILABLE");
  const filteredAvailable = available.filter((row) =>
    needle ? `${row.id} ${row.name} ${row.family}`.toLowerCase().includes(needle) : true,
  );
  const filteredOthers = needle
    ? others.filter((row) => `${row.id} ${row.name} ${row.family}`.toLowerCase().includes(needle))
    : others.filter((row) => row.access === "NOT_INCLUDED" || row.access === "UNAVAILABLE").slice(0, 8);

  return (
    <section className="grid gap-3">
      <div>
        <h2 className="font-display m-0 text-lg">Available models</h2>
        <p className="mt-1 mb-0 text-sm text-muted">
          {available.length} AVAILABLE of {catalog.models.length} discovered. Select 2–{MAX_COUNCIL_MEMBERS}. Provider
          names are not models.
        </p>
      </div>
      <input
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search AVAILABLE model id or family"
        className="min-h-11 w-full rounded-sm border border-line bg-bg px-3 text-fg"
      />
      {filteredAvailable.length ? (
        <ul className="m-0 grid max-h-log list-none gap-2 overflow-auto p-0">
          {filteredAvailable.map((row) => (
            <ModelRow
              key={row.id}
              row={row}
              checked={selected.has(row.id)}
              disabled={!selected.has(row.id) && selectedIds.length >= MAX_COUNCIL_MEMBERS}
              onToggle={() => onToggle(row.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-muted">No AVAILABLE models in this scan.</p>
      )}
      {filteredOthers.length ? (
        <div className="grid gap-2">
          <p className="m-0 text-xs font-semibold tracking-widest text-muted uppercase">Not available on this account</p>
          <ul className="m-0 grid list-none gap-1 p-0">
            {filteredOthers.map((row) => (
              <li key={row.id} className="text-sm text-muted">
                <span className={ACCESS_CLASS[row.access]}>{ACCESS_LABEL[row.access]}</span>
                {" · "}
                <span className="font-mono break-all">{row.id}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <label className="grid gap-1 text-sm">
        <span className="font-medium text-muted">Synthesis model</span>
        <select
          className="min-h-11 rounded-sm border border-line bg-bg px-3 text-fg"
          value={synthesizerModel}
          onChange={(e) => onSynthesizer(e.target.value)}
        >
          <option value="">Automatic — strongest selected AVAILABLE model</option>
          {selectedIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

function ModelRow({
  row,
  checked,
  disabled,
  onToggle,
}: {
  row: DiscoveredModel;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label
        className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-3 ${
          checked ? "border-accent bg-subtle" : "border-line bg-bg"
        } ${disabled ? "opacity-60" : ""}`}
      >
        <input
          type="checkbox"
          className="mt-1 size-4 accent-current"
          checked={checked}
          disabled={disabled && !checked}
          onChange={onToggle}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-fg">{row.name}</span>
            {checked ? <Check className="size-4 text-ok" aria-hidden="true" /> : null}
          </span>
          <span className="block font-mono text-xs break-all text-faint">{row.id}</span>
          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span className={ACCESS_CLASS[row.access]}>{ACCESS_LABEL[row.access]}</span>
            <span className="text-muted">{row.family}</span>
            {row.recommendedRole ? (
              <span className="text-muted">Recommended: {roleName(row.recommendedRole)}</span>
            ) : null}
          </span>
        </span>
      </label>
    </li>
  );
}

function roleName(role: CouncilRole): string {
  return ROLE_LABEL[role];
}

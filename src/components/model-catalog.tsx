import { Check } from "lucide-react";
import { ROLE_LABEL, type CouncilRole } from "@/lib/council/roles";
import { MAX_COUNCIL_MEMBERS, MIN_COUNCIL_MEMBERS } from "@/lib/council/members";
import type { DiscoveredModel, DiscoverySnapshot, ModelAccess } from "@/lib/council/discover";

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

function canSelect(access: ModelAccess): boolean {
  return access === "AVAILABLE" || access === "UNKNOWN";
}

export function ModelCatalogPanel({
  catalog,
  selectedIds,
  synthesizerModel,
  query,
  onQuery,
  onToggle,
  onAcceptRecommended,
  onSynthesizer,
}: {
  catalog: DiscoverySnapshot | null;
  selectedIds: string[];
  synthesizerModel: string;
  query: string;
  onQuery: (value: string) => void;
  onToggle: (id: string) => void;
  onAcceptRecommended: () => void;
  onSynthesizer: (id: string) => void;
}) {
  if (!catalog) {
    return (
      <p className="m-0 max-w-measure text-muted">
        Test Connection fetches the live model catalog and checks whether this account can actually call the
        recommended models. Catalog presence is not treated as access.
      </p>
    );
  }

  const needle = query.trim().toLowerCase();
  const selected = new Set(selectedIds);
  const visible = catalog.models.filter((row) => {
    if (!needle) {
      return selected.has(row.id) || catalog.recommendedIds.includes(row.id) || row.score >= 80;
    }
    return `${row.id} ${row.name} ${row.family} ${row.recommendedRole ?? ""}`.toLowerCase().includes(needle);
  });
  const shown = (needle ? visible : visible.slice(0, 24)).sort((a, b) => {
    const sel = Number(selected.has(b.id)) - Number(selected.has(a.id));
    if (sel) return sel;
    const rec = Number(catalog.recommendedIds.includes(b.id)) - Number(catalog.recommendedIds.includes(a.id));
    if (rec) return rec;
    return b.score - a.score;
  });
  const fetched = new Date(catalog.fetchedAt);
  const stamp = Number.isNaN(fetched.getTime()) ? catalog.fetchedAt : fetched.toLocaleString();

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display m-0 text-lg">Discovered models</h2>
          <p className="mt-1 mb-0 text-sm text-muted">
            {catalog.models.length} listed · cached {stamp}. Recommend {MIN_COUNCIL_MEMBERS}–{MAX_COUNCIL_MEMBERS}.
            Selected {selectedIds.length}/{MAX_COUNCIL_MEMBERS}.
          </p>
        </div>
        <button
          type="button"
          className="min-h-11 rounded-sm border border-line bg-transparent px-3.5 font-semibold text-fg"
          onClick={onAcceptRecommended}
        >
          Accept recommended
        </button>
      </div>
      <input
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search model id, family, or role"
        className="min-h-11 w-full rounded-sm border border-line bg-bg px-3 text-fg"
      />
      <ul className="m-0 grid max-h-log list-none gap-2 overflow-auto p-0">
        {shown.map((row) => (
          <ModelRow
            key={row.id}
            row={row}
            checked={selected.has(row.id)}
            disabled={!selected.has(row.id) && (selectedIds.length >= MAX_COUNCIL_MEMBERS || !canSelect(row.access))}
            onToggle={() => onToggle(row.id)}
          />
        ))}
      </ul>
      <label className="grid gap-1 text-sm">
        <span className="font-medium text-muted">Synthesis model</span>
        <select
          className="min-h-11 rounded-sm border border-line bg-bg px-3 text-fg"
          value={synthesizerModel}
          onChange={(e) => onSynthesizer(e.target.value)}
        >
          <option value="">Automatic — strongest selected model</option>
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
            {row.probed ? <span className="text-faint">probed</span> : <span className="text-faint">catalog only</span>}
          </span>
        </span>
      </label>
    </li>
  );
}

function roleName(role: CouncilRole): string {
  return ROLE_LABEL[role];
}

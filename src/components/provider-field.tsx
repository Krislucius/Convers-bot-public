import { Field, Select } from "@/components/council-ui";
import { PROVIDER_LABEL, PROVIDERS } from "@/lib/history/format";
import type { ChatProvider } from "@/lib/history/types";

export function ProviderField({
  value,
  onChange,
  allowAuto = true,
}: {
  value: ChatProvider | "AUTO";
  onChange: (value: ChatProvider | "AUTO") => void;
  allowAuto?: boolean;
}) {
  return (
    <Field label="Provider">
      <Select value={value} onChange={(e) => onChange(e.target.value as ChatProvider | "AUTO")}>
        {allowAuto ? <option value="AUTO">Auto detect</option> : null}
        {PROVIDERS.map((provider) => (
          <option key={provider} value={provider}>
            {PROVIDER_LABEL[provider]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

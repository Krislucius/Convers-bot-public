import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import type { CouncilStatus, TaskStatus } from "@/lib/council/types";

export function Page({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-page flex-1 px-4 py-7 pb-16">{children}</main>;
}

export function Crumb({ children }: { children: ReactNode }) {
  return <nav className="mb-4 text-sm text-faint">{children}</nav>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-6">
      <h1 className="font-display mb-3 text-display font-semibold tracking-tight text-balance">{title}</h1>
      {children}
    </header>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`my-6 rounded-xl border border-line bg-elevated p-6 ${className}`}>{children}</section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium text-muted">
      {label}
      {children}
      {hint ? <span className="font-normal text-faint">{hint}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      className={`min-h-11 w-full rounded-sm border border-line bg-bg px-3 py-2.5 text-fg placeholder:text-faint ${className}`}
    />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return (
    <textarea
      {...rest}
      className={`min-h-24 w-full resize-y rounded-sm border border-line bg-bg px-3 py-2.5 text-fg placeholder:text-faint ${className}`}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return (
    <select
      {...rest}
      className={`min-h-11 w-full rounded-sm border border-line bg-bg px-3 text-fg ${className}`}
    />
  );
}

export function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = "", ...rest } = props;
  return (
    <button
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center rounded-sm border border-accent bg-accent px-3.5 py-2.5 font-semibold text-accent-fg disabled:opacity-55 ${className}`}
    />
  );
}

export function GhostButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = "", ...rest } = props;
  return (
    <button
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-line bg-transparent px-3.5 py-2.5 font-semibold text-fg disabled:opacity-55 ${className}`}
    />
  );
}

export function DangerButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = "", ...rest } = props;
  return (
    <button
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-danger bg-transparent px-3.5 py-2.5 font-semibold text-danger disabled:opacity-55 ${className}`}
    />
  );
}

export function StatusPill({ status }: { status: TaskStatus | CouncilStatus | string }) {
  const tone =
    status === "COMPLETE" ||
    status === "APPROVED" ||
    status === "PASS" ||
    status === "CLOSED" ||
    status === "SUCCEEDED" ||
    status === "ACCESSIBLE" ||
    status === "IMPORTED" ||
    status === "CACHE_HIT" ||
    status === "DONE"
      ? "text-ok"
      : status === "FAILED" ||
          status === "BLOCKED" ||
          status === "FETCH_FAILED" ||
          status === "NOT_FOUND" ||
          status === "REIMPORT_REQUIRED"
        ? "text-danger"
        : status === "USER_DECISION_REQUIRED" ||
            status === "AUTH_REQUIRED" ||
            status === "PENDING" ||
            status === "UNSUPPORTED" ||
            status === "PARTIAL" ||
            status === "PATCH" ||
            status === "REVIEW_OPEN" ||
            status === "PREPARING" ||
            status === "WAITING" ||
            status === "RUNNING"
          ? "text-warn"
          : status === "ARCHIVED"
            ? "text-faint"
            : "text-info";
  const label = status.replaceAll("_", " ");
  return (
    <span className={`inline-block rounded-full border border-line px-2 py-1 text-xs tracking-wide uppercase ${tone}`}>
      {label}
    </span>
  );
}

export function Banner({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-elevated p-5">
      <div className="max-w-measure">
        <h2 className="font-display mb-1 text-xl">{title}</h2>
        <p className="m-0 text-muted">{body}</p>
      </div>
      {action}
    </section>
  );
}

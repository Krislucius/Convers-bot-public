import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { Banner, Field, Page, PageHeader, Panel, PrimaryButton, TextArea, TextInput } from "@/components/council-ui";
import { providerName } from "@/lib/council/providers";
import { createProject, useStore } from "@/lib/council/store";
import { useSession } from "@/lib/council/session";
import { useI18n } from "@/lib/i18n/provider";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { projects } = useStore();
  const { config } = useSession();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function onCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const project = createProject(trimmed, description.trim());
    setName("");
    setDescription("");
    void navigate({ to: "/p/$projectId", params: { projectId: project.id } });
  }

  return (
    <Page>
      {!config.ready ? (
        <Banner
          title={t("banner.councilOffTitle")}
          body={t("banner.councilOffBody")}
          action={
            <Link
              to="/settings"
              className="inline-flex min-h-11 items-center rounded-sm border border-accent bg-accent px-4 font-semibold text-accent-fg no-underline"
            >
              {t("banner.connect", { provider: providerName(config.provider) })}
            </Link>
          }
        />
      ) : null}

      <PageHeader title={t("nav.projects")}>
        <p className="max-w-measure text-muted">{t("home.subtitle")}</p>
      </PageHeader>

      {projects.length === 0 ? (
        <p className="text-muted">{t("home.noProjects")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to="/p/$projectId"
                params={{ projectId: p.id }}
                className="grid gap-1.5 rounded-lg border border-line bg-elevated p-4 no-underline transition-colors hover:bg-subtle"
              >
                <strong className="font-display text-lg">{p.name}</strong>
                <span className="text-muted">{p.description || t("home.noDescription")}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Panel>
        <h2 className="font-display mb-3 text-lg">{t("home.newProject")}</h2>
        <form className="grid gap-3" onSubmit={onCreate}>
          <Field label={t("home.name")}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label={t("home.description")}>
            <TextArea value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <PrimaryButton type="submit">{t("home.create")}</PrimaryButton>
        </form>
      </Panel>
    </Page>
  );
}
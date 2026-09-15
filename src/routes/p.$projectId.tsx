import { Outlet, createFileRoute, Link } from "@tanstack/react-router";
import { Banner, Crumb, Page, PageHeader } from "@/components/council-ui";
import { ProjectNav } from "@/components/project-nav";
import { providerName } from "@/lib/council/providers";
import { useSession } from "@/lib/council/session";
import { useStore } from "@/lib/council/store";
import { useI18n } from "@/lib/i18n/provider";

export const Route = createFileRoute("/p/$projectId")({ component: ProjectLayout });

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const store = useStore();
  const { config } = useSession();
  const { t } = useI18n();
  const project = store.projects.find((row) => row.id === projectId);

  if (!project) {
    return (
      <Page>
        <p className="text-danger">{t("project.notFound")}</p>
      </Page>
    );
  }

  return (
    <Page>
      <Crumb>
        <Link to="/" className="text-muted">
          {t("nav.projects")}
        </Link>
        {" / "}
        {project.name}
      </Crumb>
      <PageHeader title={project.name}>
        <p className="max-w-measure text-muted">{project.description}</p>
      </PageHeader>

      {!config.ready ? (
        <Banner
          title={t("banner.providerOffTitle", { provider: providerName(config.provider) })}
          body={t("banner.providerOffBody")}
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

      <ProjectNav projectId={projectId} />
      <Outlet />
    </Page>
  );
}
import { Outlet, createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Banner, Crumb, GhostButton, Page, PageHeader } from "@/components/council-ui";
import { ProjectNav } from "@/components/project-nav";
import { providerName } from "@/lib/council/providers";
import { useSession } from "@/lib/council/session";
import { setProjectWorkMode, useStore } from "@/lib/council/store";
import { useI18n } from "@/lib/i18n/provider";

export const Route = createFileRoute("/p/$projectId")({ component: ProjectLayout });

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const store = useStore();
  const { config } = useSession();
  const { t } = useI18n();
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const project = store.projects.find((row) => row.id === projectId);
  const mode = project?.workMode === "SOLO" ? "SOLO" : "COUNCIL";

  if (!project) {
    return (
      <Page>
        <p className="text-danger">{t("project.notFound")}</p>
      </Page>
    );
  }

  function choose(next: "SOLO" | "COUNCIL") {
    setProjectWorkMode(projectId, next);
    if (next === "SOLO") {
      void navigate({ to: "/p/$projectId/solo", params: { projectId }, search: { thread: undefined } });
      return;
    }
    if (path.endsWith("/solo")) void navigate({ to: "/p/$projectId", params: { projectId } });
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
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={t("solo.title")}>
        <GhostButton type="button" aria-pressed={mode === "SOLO"} onClick={() => choose("SOLO")}>
          {t("mode.work.solo")}
        </GhostButton>
        <GhostButton type="button" aria-pressed={mode === "COUNCIL"} onClick={() => choose("COUNCIL")}>
          {t("mode.work.council")}
        </GhostButton>
      </div>

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
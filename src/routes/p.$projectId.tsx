import { Outlet, createFileRoute, Link } from "@tanstack/react-router";
import { Banner, Crumb, Page, PageHeader } from "@/components/council-ui";
import { ProjectNav } from "@/components/project-nav";
import { providerName } from "@/lib/council/providers";
import { useSession } from "@/lib/council/session";
import { useStore } from "@/lib/council/store";

export const Route = createFileRoute("/p/$projectId")({ component: ProjectLayout });

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const store = useStore();
  const { config } = useSession();
  const project = store.projects.find((row) => row.id === projectId);

  if (!project) {
    return (
      <Page>
        <p className="text-danger">Project not found.</p>
      </Page>
    );
  }

  return (
    <Page>
      <Crumb>
        <Link to="/" className="text-muted">
          Projects
        </Link>
        {" / "}
        {project.name}
      </Crumb>
      <PageHeader title={project.name}>
        <p className="max-w-measure text-muted">{project.description}</p>
      </PageHeader>

      {!config.ready ? (
        <Banner
          title={`${providerName(config.provider)} is not connected.`}
          body="You can add chats, memory, and tasks now. Council runs stay disabled until a key is saved."
          action={
            <Link
              to="/settings"
              className="inline-flex min-h-11 items-center rounded-sm border border-accent bg-accent px-4 font-semibold text-accent-fg no-underline"
            >
              Connect {providerName(config.provider)}
            </Link>
          }
        />
      ) : null}

      <ProjectNav projectId={projectId} />
      <Outlet />
    </Page>
  );
}

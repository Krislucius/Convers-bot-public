import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { Banner, Field, Page, PageHeader, Panel, PrimaryButton, TextArea, TextInput } from "@/components/council-ui";
import { providerName } from "@/lib/council/providers";
import { createProject, useStore } from "@/lib/council/store";
import { useSession } from "@/lib/council/session";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { projects } = useStore();
  const { config } = useSession();
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
          title="AI Council is not connected yet."
          body="You can still create projects and tasks. Council runs need a saved API key."
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

      <PageHeader title="Projects">
        <p className="max-w-measure text-muted">
          One task goes to three independent reviewers. Round 2 is a cross-review. A local gate can override
          the synthesizer on P0 and P1.
        </p>
      </PageHeader>

      {projects.length === 0 ? (
        <p className="text-muted">No projects on this account yet. Create one below.</p>
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
                <span className="text-muted">{p.description || "No description."}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Panel>
        <h2 className="font-display mb-3 text-lg">New project</h2>
        <form className="grid gap-3" onSubmit={onCreate}>
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Description">
            <TextArea value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <PrimaryButton type="submit">Create project</PrimaryButton>
        </form>
      </Panel>
    </Page>
  );
}

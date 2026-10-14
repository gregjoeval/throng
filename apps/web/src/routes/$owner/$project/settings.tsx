import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ProjectView } from "@/components/project-view";
import { SecretsSettings } from "@/components/secrets-settings";
import { EmptyState, Loading } from "@/components/states";
import { meQuery, projectQuery } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";

export const Route = createFileRoute("/$owner/$project/settings")({ component: Settings });

/** The project's settings, which only its owner sees: for now, its secrets. */
function Settings() {
  const { owner, project } = Route.useParams();
  return (
    <ProjectView location={{ view: "settings", owner, project }}>
      <OwnerOnly projectRef={{ owner, project }} />
    </ProjectView>
  );
}

function OwnerOnly({ projectRef }: { projectRef: ProjectRef }) {
  const me = useQuery(meQuery);
  const found = useQuery(projectQuery(projectRef));
  if (!me.isSuccess || !found.isSuccess) return <Loading />;
  if (me.data.user.id !== found.data.owner.id) {
    return <EmptyState title="Only the project owner can see its settings." />;
  }
  return <SecretsSettings projectRef={projectRef} />;
}

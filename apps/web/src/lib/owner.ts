import { useQuery } from "@tanstack/react-query";
import { meQuery, projectQuery } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";

/**
 * Whether the signed-in user owns the project, acting as themselves (the browser always does):
 * who may cancel or start a run. False until both are known.
 */
export function useIsOwner(projectRef: ProjectRef): boolean {
  const me = useQuery(meQuery);
  const project = useQuery(projectQuery(projectRef));
  return me.isSuccess && project.isSuccess && me.data.alias === null && me.data.user.id === project.data.owner.id;
}

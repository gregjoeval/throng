// The project home's About sidebar, like a GitHub repository's: a description, where the project
// came from, who authored the commits on `main` and the languages its code is in. The platform
// computes the stats in one call (`/stats`), so the browser never walks the tree.

import { useQuery } from "@tanstack/react-query";
import { LinkIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { ErrorState, Loading } from "@/components/states";
import { projectQuery, statsQuery } from "@/lib/api";
import type { ProjectRef, ProjectStats } from "@/lib/api";

/** Commit authors listed by name; the rest are counted. */
const SHOWN_AUTHORS = 10;
/** Languages given a colour of their own; the rest are summed as `Other`. */
const SHOWN_LANGUAGES = 4;
/** The theme's chart colours, one per shown language, then one for `Other`. */
const LANGUAGE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

type Language = ProjectStats["languages"][number];

export function About({ projectRef }: { projectRef: ProjectRef }) {
  const stats = useQuery(statsQuery(projectRef));
  const project = useQuery(projectQuery(projectRef));
  return (
    <aside aria-label="About" className="flex flex-col gap-4 rounded-xl border p-4 text-sm">
      <h2 className="font-heading font-medium">About</h2>
      {stats.isPending && <Loading />}
      {stats.isError && <ErrorState error={stats.error} />}
      {stats.isSuccess && <AboutBody stats={stats.data} source={project.data?.source ?? null} />}
    </aside>
  );
}

function AboutBody({ stats, source }: { stats: ProjectStats; source: string | null }) {
  const { description, commitAuthors, languages } = stats;
  return (
    <>
      {description === null ? <p className="text-muted-foreground italic">No description.</p> : <p>{description}</p>}
      {source === null ? null : (
        // The platform only accepts https sources, so it's safe as a link.
        <a href={source} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2 hover:underline">
          <LinkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{source.replace(/^https:\/\//u, "")}</span>
        </a>
      )}
      <section aria-label="Commit authors" className="flex flex-col gap-2 border-t pt-4">
        <h3 className="font-medium">
          Commit authors{" "}
          <span className="text-muted-foreground">
            {commitAuthors.length}
            {stats.commitsTruncated ? "+" : null}
          </span>
        </h3>
        {commitAuthors.length === 0 ? (
          <p className="text-muted-foreground">No commits yet.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {commitAuthors.slice(0, SHOWN_AUTHORS).map((c) => (
              <li key={c.email} className="flex justify-between gap-2">
                <span className="truncate" title={c.email}>
                  {c.name}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {c.commits} {c.commits === 1 ? "commit" : "commits"}
                </span>
              </li>
            ))}
          </ol>
        )}
        {commitAuthors.length > SHOWN_AUTHORS && (
          <p className="text-muted-foreground">and {commitAuthors.length - SHOWN_AUTHORS} more</p>
        )}
        {stats.commitsTruncated && (
          <p className="text-xs text-muted-foreground">Counted from the newest commits only.</p>
        )}
      </section>
      <section aria-label="Languages" className="flex flex-col gap-2 border-t pt-4">
        <h3 className="font-medium">Languages</h3>
        {languages.length === 0 ? <p className="text-muted-foreground">No code yet.</p> : <Languages all={languages} />}
        {stats.filesTruncated && (
          <p className="text-xs text-muted-foreground">Counted from the files nearest the root only.</p>
        )}
      </section>
    </>
  );
}

/** A bar of each language's share, with the same shares listed below it as text. */
function Languages({ all }: { all: Language[] }) {
  const shown = grouped(all);
  return (
    <>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        {shown.map((l, i) => (
          <span key={l.name} className="h-full" style={segment(l, i)} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {shown.map((l, i) => (
          <li key={l.name} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: LANGUAGE_COLORS[i] }} aria-hidden />
            <span className="font-medium">{l.name}</span>
            <span className="text-muted-foreground tabular-nums">{percent(l.share)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function segment(language: Language, index: number): CSSProperties {
  return { width: `${language.share * 100}%`, backgroundColor: LANGUAGE_COLORS[index] };
}

/** The first `SHOWN_LANGUAGES` languages, and the rest summed as `Other` when there's more than one. */
function grouped(languages: Language[]): Language[] {
  if (languages.length <= SHOWN_LANGUAGES + 1) return languages;
  const rest = languages.slice(SHOWN_LANGUAGES);
  const other = rest.reduce((sum, l) => ({ ...sum, bytes: sum.bytes + l.bytes, share: sum.share + l.share }), {
    name: "Other",
    bytes: 0,
    share: 0,
  });
  return [...languages.slice(0, SHOWN_LANGUAGES), other];
}

/** A share as a percentage to one decimal place, never rounding a share above nothing down to `0.0%`. */
function percent(share: number): string {
  const value = share * 100;
  return value > 0 && value < 0.1 ? "<0.1%" : `${value.toFixed(1)}%`;
}

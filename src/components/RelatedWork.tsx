import { ArrowUpRight, ChartNoAxesCombined, Database } from "lucide-react";
import type { ChartSourceOption } from "../chart-workspace/contract";
import type { RelatedChart } from "../workspaceNavigation";

export function RelatedWork({
  queries,
  charts,
  onOpenQuery,
  onOpenChart,
}: {
  queries: readonly ChartSourceOption[];
  charts: readonly RelatedChart[];
  onOpenQuery(id: string): void;
  onOpenChart(chart: RelatedChart): void;
}) {
  return (
    <aside aria-label="Related Work" className="file-related-work" id="file-related-work">
      <header>
        <strong>Related Work</strong>
      </header>
      {queries.length > 0 && (
        <section aria-label="Related SQL tabs">
          <h2>SQL</h2>
          {queries.map((query) => (
            <button key={query.id} type="button" onClick={() => onOpenQuery(query.id)}>
              <Database aria-hidden="true" />
              <span title={query.name}>{query.name}</span>
              <ArrowUpRight aria-hidden="true" />
            </button>
          ))}
        </section>
      )}
      {charts.length > 0 && (
        <section aria-label="Related charts">
          <h2>Charts</h2>
          {charts.map((chart) => (
            <button
              aria-label={chart.title}
              key={chart.cardId}
              type="button"
              onClick={() => onOpenChart(chart)}
            >
              <ChartNoAxesCombined aria-hidden="true" />
              <span>
                <strong title={chart.title}>{chart.title}</strong>
                <small>{chart.sheetName}</small>
              </span>
              <ArrowUpRight aria-hidden="true" />
            </button>
          ))}
        </section>
      )}
    </aside>
  );
}

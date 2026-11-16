import { useLayoutEffect, useRef } from "react";
import type { ChartData } from "./contract";
import { categoryName, formatCoordinate } from "./chartSeries";
import type { useChartDetail } from "./useChartDetail";

const number = new Intl.NumberFormat("en-US");
const pageSize = 32;

export interface GroupView {
  key: string;
  offset: number;
  search: string;
  group?: string;
}

export function ChartGroupDetails({
  categories,
  view,
  setView,
  result,
  close,
}: {
  categories: boolean;
  view: GroupView;
  setView(view: GroupView): void;
  result: ReturnType<typeof useChartDetail>;
  close(): void;
}) {
  const subject = categories ? "categories" : "groups";
  const directory = result.data?.groupDirectory;
  const group: NonNullable<ChartData["groups"]>[number] | undefined = result.data?.groups?.[0];
  const selected = view.group !== undefined;
  const search = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    (selected ? back.current : search.current)?.focus();
  }, [selected]);
  return (
    <section className="chart-group-details" aria-label={`Chart ${subject}`}>
      <div className="chart-group-details-heading">
        {selected ? (
          <button type="button" ref={back} onClick={() => setView({ ...view, group: undefined })}>
            Back to groups
          </button>
        ) : (
          <input
            ref={search}
            aria-label={categories ? "Search categories" : "Search groups"}
            placeholder={categories ? "Search categories" : "Search groups"}
            maxLength={64}
            value={view.search}
            onChange={(event) => setView({ ...view, offset: 0, search: event.currentTarget.value })}
          />
        )}
        <button type="button" onClick={close}>
          Close details
        </button>
      </div>
      {result.status === "loading" && (
        <div className="chart-group-details-status" role="status">
          Preparing detail…
          <button type="button" onClick={result.cancel}>
            Cancel detail
          </button>
        </div>
      )}
      {(result.status === "error" || result.status === "cancelled") && (
        <div className="chart-group-details-status" role="status">
          {result.error ?? "Detail cancelled."}
          <button type="button" onClick={result.retry}>
            Retry detail
          </button>
        </div>
      )}
      {result.status === "ready" && selected && group && (
        <dl className="chart-group-summary">
          <div>
            <dt>Group</dt>
            <dd>{categoryName(group.label)}</dd>
          </div>
          <div>
            <dt>Rows</dt>
            <dd>{number.format(group.count)}</dd>
          </div>
          {group.summary && (
            <>
              <div>
                <dt>Minimum</dt>
                <dd>{formatCoordinate(group.summary[0])}</dd>
              </div>
              <div>
                <dt>Median</dt>
                <dd>{formatCoordinate(group.summary[2])}</dd>
              </div>
              <div>
                <dt>Maximum</dt>
                <dd>{formatCoordinate(group.summary[4])}</dd>
              </div>
            </>
          )}
          {group.sampleCount !== undefined && (
            <div>
              <dt>Rows used for summary</dt>
              <dd>{number.format(group.sampleCount)}</dd>
            </div>
          )}
          {group.outlierCount !== undefined && (
            <div>
              <dt>Outliers</dt>
              <dd>
                {number.format(group.outliers?.length ?? 0)} of {number.format(group.outlierCount)}{" "}
                shown
              </dd>
            </div>
          )}
        </dl>
      )}
      {result.status === "ready" && selected && !group && (
        <p role="status">No observations in this group.</p>
      )}
      {result.status === "ready" &&
        !selected &&
        directory &&
        (directory.entries.length ? (
          <>
            <div className="chart-group-directory">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{categories ? "Category" : "Group"}</th>
                    <th scope="col">Rows</th>
                    {categories && <th scope="col">Value</th>}
                  </tr>
                </thead>
                <tbody>
                  {directory.entries.map((entry) => (
                    <tr key={entry.label}>
                      <th scope="row" title={categoryName(entry.label)}>
                        {categories ? (
                          categoryName(entry.label)
                        ) : (
                          <button
                            type="button"
                            aria-label={`Inspect group ${categoryName(entry.label)}`}
                            onClick={() => setView({ ...view, group: entry.label })}
                          >
                            {categoryName(entry.label)}
                          </button>
                        )}
                      </th>
                      <td>{number.format(entry.count)}</td>
                      {categories && (
                        <td>{entry.value === undefined ? "—" : formatCoordinate(entry.value)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="chart-group-pagination">
              <button
                type="button"
                disabled={directory.offset === 0}
                onClick={() =>
                  setView({ ...view, offset: Math.max(0, directory.offset - pageSize) })
                }
              >
                Previous page
              </button>
              <span role="status">
                {number.format(directory.offset + 1)}–
                {number.format(directory.offset + directory.entries.length)} of{" "}
                {number.format(directory.total)}
              </span>
              <button
                type="button"
                disabled={directory.offset + directory.entries.length >= directory.total}
                onClick={() => setView({ ...view, offset: directory.offset + pageSize })}
              >
                Next page
              </button>
            </div>
          </>
        ) : (
          <p role="status">No matching {subject}.</p>
        ))}
      {result.status === "ready" && !selected && !directory && (
        <p role="status">The {subject} list is unavailable.</p>
      )}
    </section>
  );
}

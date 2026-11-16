import { useEffect, useState, type ReactNode } from "react";
import type { SqlSourceIdentity } from "./backend";

const MAX_SOURCE_CONTEXTS = 3;
const identity = (source: SqlSourceIdentity) =>
  JSON.stringify([source.documentId, source.sessionId]);

export function SqlSourceDeck({
  source,
  active,
  renderSource,
}: {
  source: SqlSourceIdentity;
  active: boolean;
  renderSource(source: SqlSourceIdentity, active: boolean): ReactNode;
}) {
  const key = identity(source);
  const [remembered, setRemembered] = useState<SqlSourceIdentity[]>([source]);
  const contexts = [...remembered.filter((item) => identity(item) !== key), source].slice(
    -MAX_SOURCE_CONTEXTS,
  );
  useEffect(() => {
    setRemembered((previous) =>
      [...previous.filter((item) => identity(item) !== key), source].slice(-MAX_SOURCE_CONTEXTS),
    );
  }, [key, source]);
  return (
    <div
      className="sql-source-deck"
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0 }}
    >
      {contexts.map((item) => (
        <div
          key={identity(item)}
          hidden={identity(item) !== key}
          style={{
            display: identity(item) === key ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            minWidth: 0,
          }}
        >
          {renderSource(item, active && identity(item) === key)}
        </div>
      ))}
    </div>
  );
}

import type { SqlSourceIdentity } from "./sql-workspace/backend";
import type { ChartData, ChartKind } from "./chart-workspace/contract";

export type SqlNavigationRequest =
  | { id: number; kind: "new"; source: SqlSourceIdentity }
  | { id: number; kind: "tab"; tabId: string };

export interface ChartNavigationRequest {
  id: number;
  sheetId: string;
  cardId: string;
}

export interface RelatedChart {
  sheetId: string;
  sheetName: string;
  cardId: string;
  title: string;
  file?: SqlSourceIdentity;
  sqlSourceId?: string;
  referencedFiles?: SqlSourceIdentity[];
  getPreview?(): { kind: ChartKind; data: ChartData } | undefined;
}

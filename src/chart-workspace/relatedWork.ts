import type { RelatedChart } from "../workspaceNavigation";
import type { ChartSheet } from "./chartModel";
import type { ChartSourceOption } from "./contract";

export function sameRelatedWork(before: readonly ChartSheet[], after: readonly ChartSheet[]) {
  return (
    before.length === after.length &&
    before.every((previous, index) => {
      const sheet = after[index];
      return (
        previous.id === sheet.id &&
        previous.name === sheet.name &&
        previous.cards.length === sheet.cards.length &&
        previous.cards.every((previousCard, index) => {
          const card = sheet.cards[index];
          return (
            previousCard.id === card.id &&
            previousCard.title === card.title &&
            previousCard.binding === card.binding
          );
        })
      );
    })
  );
}

export function relatedCharts(
  sheets: readonly ChartSheet[],
  sources: readonly ChartSourceOption[],
): RelatedChart[] {
  return sheets.flatMap((sheet) =>
    sheet.cards.flatMap<RelatedChart>((card) => {
      const { binding } = card;
      if (!binding) return [];
      const link = {
        sheetId: sheet.id,
        sheetName: sheet.name,
        cardId: card.id,
        title: card.title,
      };
      const option =
        binding.kind === "block"
          ? sources.find(({ source }) => {
              const { origin } = binding.block;
              return (
                source?.kind === "sql" &&
                origin?.kind === "sql" &&
                source.runId === origin.runId &&
                source.resultId === origin.resultId
              );
            })
          : sources.find(({ id }) => id === binding.sourceId);
      const source = option?.source;
      if (
        binding.kind === "file" &&
        source?.kind === "file" &&
        source.sessionId === binding.sessionId
      )
        return [{ ...link, file: { documentId: source.documentId, sessionId: source.sessionId } }];
      if (binding.kind === "block" && binding.block.origin?.kind === "file") {
        const { documentId, sessionId } = binding.block.origin;
        return [{ ...link, file: { documentId, sessionId } }];
      }
      if (binding.kind === "pinned")
        return [
          {
            ...link,
            sqlSourceId: binding.sourceId,
            referencedFiles: binding.sqlReference?.referencedSources ?? [],
          },
        ];
      if (option?.kind === "sql")
        return [
          {
            ...link,
            sqlSourceId: option.id,
            referencedFiles: option.sqlReference?.referencedSources ?? [],
          },
        ];
      return [];
    }),
  );
}

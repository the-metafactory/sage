export function appendSummaryNote(summary: string, note: string): string {
  return summary.trim() === "" ? note : `${summary} ${note}`;
}

/** Send each exact text once per project; preserve the first citation id and original evidence. */
export function uniqueProjectSpans<T extends { id: string; text: string }>(spans: T[]): T[] {
  const seen = new Set<string>();
  return spans.filter(span => {
    if (seen.has(span.text)) return false;
    seen.add(span.text);
    return true;
  });
}

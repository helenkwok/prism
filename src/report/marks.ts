// 07-UI-SPEC "Snapshot view": cut archived text into plain and marked segments.
// A cited span is marked at its first exact occurrence; a span whose text is
// not in the archived text, or that overlaps an earlier mark, stays unmarked.
// Plain strings only: the page renders each segment as React text.

export type Segment = { text: string; spanId?: string };

export function markSpans(text: string, spans: { spanId: string; text: string }[]): Segment[] {
  const hits = spans
    .filter((s) => s.text.length > 0)
    .map((s) => ({ spanId: s.spanId, start: text.indexOf(s.text), end: 0 }))
    .filter((h) => h.start !== -1)
    .map((h) => ({ ...h, end: h.start + spans.find((s) => s.spanId === h.spanId)!.text.length }))
    .sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue;
    if (h.start > at) out.push({ text: text.slice(at, h.start) });
    out.push({ text: text.slice(h.start, h.end), spanId: h.spanId });
    at = h.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

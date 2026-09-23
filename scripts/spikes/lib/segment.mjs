// THROWAWAY spike-only paragraph segmenter (FND-05 matrix harness, plan 01-10).
//
// Splits page text into paragraph spans with deterministic ids (s001, s002, ...):
// same input text always yields the same ids and text. This is NOT the Phase 2
// evidence segmenter and must not be imported by it — a production segmenter
// needs HTML-structure awareness, heading detection and de-duplication that
// this script does not attempt. It exists only so the matrix harness has a
// stable set of span ids to test the {checkId, proposedState, spanIds}
// contract's span-resolution rule against.

/** Deterministic paragraph split. Returns [{ id: "s001", text }, ...]. */
export function segmentPage(text) {
  const paragraphs = String(text ?? "")
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter((p) => p.length > 0);
  return paragraphs.map((body, i) => ({ id: `s${String(i + 1).padStart(3, "0")}`, text: body }));
}

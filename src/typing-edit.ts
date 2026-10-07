// Compare graphemes so deleting an emoji or an accented character sends one
// Backspace, rather than one for each UTF-16 code unit. Never inspect host text.
export function typingEdit(previous: string, next: string) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const before = Array.from(segmenter.segment(previous), (s) => s.segment);
  const after = Array.from(segmenter.segment(next), (s) => s.segment);
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix++;
  const remove = before.length - prefix,
    text = after.slice(prefix).join("");
  if (remove > 256 || new TextEncoder().encode(text).length > 8000)
    throw Error(
      "That edit is too large. Tap the field again and type a smaller section.",
    );
  return { delete: remove, text };
}

// Bounded, grapheme-safe context for the invisible native keyboard input.
export function typingTail(text: string) {
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (s) => s.segment,
  );
  return graphemes.slice(-128).join("");
}

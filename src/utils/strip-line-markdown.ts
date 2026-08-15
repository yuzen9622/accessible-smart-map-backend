/**
 * Flattens common markdown into plain text so LINE (which renders no markdown) does
 * not show raw syntax characters. This is a best-effort cleanup, NOT a full markdown
 * parser — the model prompt forbidding markdown is the primary control and this is the
 * safety net. It is idempotent and never throws; input with no markdown is returned
 * unchanged.
 *
 * Single underscores are deliberately left untouched so `snake_case` identifiers and
 * underscores inside URLs are never corrupted.
 *
 * @param text The raw reply text, possibly containing markdown.
 * @returns The text with markdown syntax removed or flattened.
 */
export function stripLineMarkdown(text: string): string {
  if (!text) return text;

  let out = text;

  out = out.replace(
    /```[^\n`]*\n?([\s\S]*?)```/g,
    (_m, inner: string) => inner,
  );

  out = out.replace(/`([^`]+)`/g, "$1");

  const lines = out.split("\n").map((line) => {
    let l = line;
    l = l.replace(/^\s*>\s?/, "");
    l = l.replace(/^(\s*)#{1,6}\s+/, "$1");
    l = l.replace(/^(\s*)[-*+]\s+/, "$1・ ");
    return l;
  });

  const filtered = lines.filter(
    (line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || !line.includes("|"),
  );

  out = filtered
    .map((line) => {
      if (line.includes("|")) {
        return line
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .replace(/\s*\|\s*/g, "　")
          .trim();
      }
      return line;
    })
    .join("\n");

  out = out.replace(/\*\*([^\s*][^*]*?)\*\*/g, "$1");
  out = out.replace(/__([^\s_][^_]*?)__/g, "$1");
  out = out.replace(/\*([^\s*][^*]*?)\*/g, "$1");

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 $2");

  out = out.replace(/[ \t]+$/gm, "");
  out = out.replace(/\n{3,}/g, "\n\n");

  return out;
}

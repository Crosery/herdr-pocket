const INLINE_IMAGE_LIMIT = 6;
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const PATH_IMAGE_RE = /(?:^|[\s"'`(<@])((?:file:\/\/)?(?:~\/|\/(?!\/)|\.\.?\/|[a-zA-Z0-9._-]+\/)[^\s"'`<>|(){}[\]]+\.(?:png|jpe?g|gif|webp|bmp|avif|svg))(?=[?#\s"'`<>|(){}[\]),.;:]|$)/gi;

export function extractImageTargets(sources: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const cleaned = raw
      .trim()
      .replace(/^["'`<(@]+|["'`>),.;:]+$/g, "")
      .replace(/[?#].*$/, "");
    if (!cleaned || /^https?:\/\//i.test(cleaned) || cleaned.startsWith("//")) return;
    if (!/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(cleaned)) return;
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };
  for (const src of sources) {
    if (!src) continue;
    for (const m of src.matchAll(MD_IMAGE_RE)) {
      if (m[1]) add(m[1]);
      if (out.length >= INLINE_IMAGE_LIMIT) return out;
    }
    for (const m of src.matchAll(PATH_IMAGE_RE)) {
      if (m[1]) add(m[1]);
      if (out.length >= INLINE_IMAGE_LIMIT) return out;
    }
  }
  return out;
}

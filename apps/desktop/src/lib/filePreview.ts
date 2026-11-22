/**
 * Zero-dependency client-side file preview parsers optimized for sub-10ms UX:
 * - PKZIP + Web DecompressionStream ("deflate-raw") for DOCX / XLSX / PPTX / ODT / ODS
 * - OLE2 Compound File + BIFF8 parser for legacy binary .xls / .doc
 * - RFC 4180 delimiter-auto-sniffing parser for CSV / TSV / PSV
 * - Structured JSON / JSONL table extraction, RTF parser, and PDF page counter
 */

export interface TableSheetData {
  name: string;
  columns: string[];
  rows: string[][];
}

export interface TablePreviewData {
  sheets: TableSheetData[];
  truncated: boolean;
  parseMs: number;
}

export interface DocRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  color?: string;
  href?: string;
}

export type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: DocRun[] }
  | { kind: "paragraph"; runs: DocRun[]; align?: "left" | "center" | "right"; listLevel?: number; ordered?: boolean }
  | { kind: "table"; rows: Array<Array<{ runs: DocRun[]; colspan?: number }>> }
  | { kind: "image"; src: string; alt?: string };

export interface DocPreviewData {
  blocks: DocBlock[];
  mediaUrls: string[];
  parseMs: number;
}

export interface SlidePreviewItem {
  index: number;
  title: string;
  bullets: string[];
  tables: string[][][];
  images: string[];
}

export interface SlidePreviewData {
  slides: SlidePreviewItem[];
  mediaUrls: string[];
  parseMs: number;
}

interface XmlNode {
  tag: string;
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const UTF8_DECODER = new TextDecoder("utf-8");
const UTF16LE_DECODER = new TextDecoder("utf-16le");
const LATIN1_DECODER = new TextDecoder("latin1");
const GB18030_DECODER = (() => {
  try {
    return new TextDecoder("gb18030");
  } catch {
    return LATIN1_DECODER;
  }
})();

export function decodeBase64Fast(b64: string): Uint8Array {
  const fromB64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (typeof fromB64 === "function") {
    return fromB64(b64);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function u16le(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}

function u32le(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

function i32le(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24);
}

function f64le(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset + off, 8).getFloat64(0, true);
}

async function inflateRawBytes(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([ab]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error("当前运行环境不支持 deflate-raw 解压");
}

/** Extracts selected entries from a PKZIP container in parallel. */
export async function unzipEntries(
  bytes: Uint8Array,
  filter?: (name: string) => boolean,
): Promise<Map<string, Uint8Array>> {
  if (bytes.length < 22) throw new Error("无效的压缩文档（文件过短）");

  const minEocd = Math.max(0, bytes.length - 65557);
  let eocdOff = -1;
  for (let i = bytes.length - 22; i >= minEocd; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error("无法识别的 ZIP/Office 文档结构");

  const totalEntries = u16le(bytes, eocdOff + 10);
  const cdSize = u32le(bytes, eocdOff + 12);
  const cdOffset = u32le(bytes, eocdOff + 16);
  const cdEnd = Math.min(bytes.length, cdOffset + cdSize);

  const pending: Array<{ name: string; method: number; slice: Uint8Array }> = [];
  let cursor = cdOffset;
  let seen = 0;

  while (cursor + 46 <= cdEnd && seen < totalEntries) {
    if (u32le(bytes, cursor) !== 0x02014b50) break;
    const method = u16le(bytes, cursor + 10);
    const compSize = u32le(bytes, cursor + 20);
    const nameLen = u16le(bytes, cursor + 28);
    const extraLen = u16le(bytes, cursor + 30);
    const commentLen = u16le(bytes, cursor + 32);
    const lfhOffset = u32le(bytes, cursor + 42);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLen);
    const name = UTF8_DECODER.decode(nameBytes);
    cursor += 46 + nameLen + extraLen + commentLen;
    seen += 1;

    if (name.endsWith("/") || (filter && !filter(name))) continue;
    if (lfhOffset + 30 > bytes.length || u32le(bytes, lfhOffset) !== 0x04034b50) continue;

    const lfhNameLen = u16le(bytes, lfhOffset + 26);
    const lfhExtraLen = u16le(bytes, lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = Math.min(bytes.length, dataStart + compSize);
    if (dataStart > bytes.length) continue;
    pending.push({ name, method, slice: bytes.subarray(dataStart, dataEnd) });
  }

  const out = new Map<string, Uint8Array>();
  await Promise.all(
    pending.map(async (item) => {
      if (item.method === 0) {
        out.set(item.name, item.slice);
      } else if (item.method === 8) {
        out.set(item.name, await inflateRawBytes(item.slice));
      }
    }),
  );
  return out;
}

function decodeXmlEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? Number.parseInt(ent.slice(2), 16)
        : Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    }
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "amp") return "&";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    return "";
  });
}

function parseXmlAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!raw || !raw.includes("=")) return attrs;
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const val = decodeXmlEntities(m[2] ?? m[3] ?? "");
    const full = m[1]!;
    attrs[full] = val;
    const colon = full.indexOf(":");
    if (colon >= 0) {
      const short = full.slice(colon + 1);
      if (!(short in attrs)) attrs[short] = val;
    }
  }
  return attrs;
}

function localTagName(tag: string): string {
  const colon = tag.indexOf(":");
  return colon >= 0 ? tag.slice(colon + 1) : tag;
}

/** Fast non-DOM XML parser supporting namespaces, entities, comments, and CDATA. */
export function parseXmlNodes(xml: string): XmlNode {
  const root: XmlNode = { tag: "#root", local: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const len = xml.length;
  let i = 0;

  while (i < len) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      const tail = decodeXmlEntities(xml.slice(i));
      if (tail) stack[stack.length - 1]!.text += tail;
      break;
    }
    if (lt > i) {
      const txt = decodeXmlEntities(xml.slice(i, lt));
      const top = stack[stack.length - 1]!;
      if (top.children.length === 0) {
        top.text += txt;
      } else if (txt) {
        top.children.push({ tag: "#text", local: "#text", attrs: {}, children: [], text: txt });
      }
    }

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const data = end < 0 ? xml.slice(lt + 9) : xml.slice(lt + 9, end);
      const top = stack[stack.length - 1]!;
      if (top.children.length === 0) top.text += data;
      else top.children.push({ tag: "#text", local: "#text", attrs: {}, children: [], text: data });
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const gt = xml.indexOf(">", lt + 2);
      i = gt < 0 ? len : gt + 1;
      continue;
    }

    // Find '>' outside quotes
    let gt = -1;
    let quote = "";
    for (let k = lt + 1; k < len; k += 1) {
      const c = xml[k]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        gt = k;
        break;
      }
    }
    if (gt < 0) break;

    const inside = xml.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!inside) continue;

    if (inside[0] === "/") {
      const closeName = inside.slice(1).trim();
      const closeLocal = localTagName(closeName);
      for (let s = stack.length - 1; s >= 1; s -= 1) {
        if (stack[s]!.tag === closeName || stack[s]!.local === closeLocal) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const selfClose = inside.endsWith("/");
    const body = selfClose ? inside.slice(0, -1).trimEnd() : inside;
    let sp = -1;
    for (let k = 0; k < body.length; k += 1) {
      const c = body[k]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        sp = k;
        break;
      }
    }
    const tag = sp < 0 ? body : body.slice(0, sp);
    const attrRaw = sp < 0 ? "" : body.slice(sp + 1);
    const node: XmlNode = {
      tag,
      local: localTagName(tag),
      attrs: parseXmlAttrs(attrRaw),
      children: [],
      text: "",
    };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function xmlText(node: XmlNode): string {
  if (node.children.length === 0) return node.text;
  let out = node.text;
  for (const child of node.children) out += xmlText(child);
  return out;
}

function xmlChildren(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((c) => c.local === local);
}

function xmlFindAll(node: XmlNode, local: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.local === local) out.push(child);
    if (child.children.length > 0) xmlFindAll(child, local, out);
  }
  return out;
}

function xmlFindFirst(node: XmlNode, local: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.local === local) return child;
    if (child.children.length > 0) {
      const hit = xmlFindFirst(child, local);
      if (hit) return hit;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Delimited text (CSV / TSV / PSV) & Tabular JSON / JSONL
// ---------------------------------------------------------------------------

function sniffDelimiter(sample: string): string {
  const candidates = ["\t", ",", ";", "|"];
  const lines = sample.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 8);
  if (!lines.length) return ",";

  let best = ",";
  let bestScore = -1;
  for (const d of candidates) {
    let counts: number[] = [];
    for (const line of lines) {
      let count = 0;
      let inQ = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]!;
        if (ch === '"') inQ = !inQ;
        else if (!inQ && ch === d) count += 1;
      }
      counts.push(count);
    }
    const nonZero = counts.filter((c) => c > 0);
    if (nonZero.length === 0) continue;
    const avg = nonZero.reduce((a, b) => a + b, 0) / lines.length;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const consistency = min === max ? 2 : 1;
    const score = avg * consistency + (d === "\t" ? 0.1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function buildSheetFromRawRows(name: string, rawRows: string[][]): TableSheetData {
  if (rawRows.length === 0) return { name, columns: ["列 1"], rows: [] };
  const first = rawRows[0]!;
  let maxCols = first.length;
  for (let i = 1; i < Math.min(rawRows.length, 200); i += 1) {
    if (rawRows[i]!.length > maxCols) maxCols = rawRows[i]!.length;
  }
  const colCount = Math.max(1, maxCols);
  const columns = Array.from({ length: colCount }, (_, ci) => {
    const h = first[ci]?.trim();
    return h || `列 ${ci + 1}`;
  });
  const rows = rawRows.slice(1);
  return { name, columns, rows };
}

export function parseDelimitedTable(
  input: string,
  explicitDelimiter?: string,
  maxRows = 100_000,
): TablePreviewData {
  const t0 = performance.now();
  const raw = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = explicitDelimiter || sniffDelimiter(raw.slice(0, 8192));

  const rawRows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  let truncated = false;
  const len = raw.length;

  while (i < len) {
    const ch = raw[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        cell += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && raw[i + 1] === "\n") i += 1;
      row.push(cell);
      rawRows.push(row);
      row = [];
      cell = "";
      i += 1;
      if (rawRows.length >= maxRows + 1) {
        truncated = i < len;
        break;
      }
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (!truncated && (cell.length > 0 || row.length > 0)) {
    row.push(cell);
    rawRows.push(row);
  }

  return {
    sheets: [buildSheetFromRawRows("Sheet1", rawRows)],
    truncated,
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

function formatTableCellValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

export function parseJsonTable(
  raw: string,
  isJsonLines: boolean,
  maxRows = 50_000,
): TablePreviewData | null {
  const t0 = performance.now();
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const items: Array<Record<string, unknown>> = [];
  let truncated = false;

  if (isJsonLines) {
    const lines = clean.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (items.length >= maxRows) {
        truncated = true;
        break;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          items.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Ignore trailing truncated line in huge JSONL files
      }
    }
    if (items.length === 0) return null;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    for (let i = 0; i < parsed.length; i += 1) {
      if (items.length >= maxRows) {
        truncated = true;
        break;
      }
      const item = parsed[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      items.push(item as Record<string, unknown>);
    }
    if (items.length === 0) return null;
  }

  const columns: string[] = [];
  const colSet = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!colSet.has(key)) {
        colSet.add(key);
        columns.push(key);
      }
    }
  }
  if (columns.length === 0) return null;

  const rows = items.map((item) => columns.map((col) => formatTableCellValue(item[col])));
  return {
    sheets: [{ name: isJsonLines ? "JSONL" : "JSON", columns, rows }],
    truncated,
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// XLSX & ODS & Legacy XLS Spreadsheets
// ---------------------------------------------------------------------------

function colLettersToIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i += 1) {
    const code = letters.charCodeAt(i);
    const upper = code >= 97 ? code - 32 : code;
    if (upper < 65 || upper > 90) break;
    idx = idx * 26 + (upper - 64);
  }
  return Math.max(0, idx - 1);
}

function isBuiltinDateFormatId(numFmtId: number): boolean {
  return (numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47);
}

function looksLikeDateFormatCode(code: string): boolean {
  const clean = code.replace(/\[[^\]]*\]|"[^"]*"|\\./g, "").toLowerCase();
  return /[ymd]/.test(clean) && !/^[#0.,;%e+\-\s]+$/.test(clean);
}

function formatExcelSerialDate(serial: number): string {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return String(serial);
  const adjusted = serial > 59 ? serial - 1 : serial;
  const epochMs = Date.UTC(1899, 11, 31) + Math.round(adjusted * 86_400_000);
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = d.getUTCHours();
  const min = d.getUTCMinutes();
  if (hh === 0 && min === 0) return `${yyyy}-${mm}-${dd}`;
  return `${yyyy}-${mm}-${dd} ${String(hh).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function normalizeZipTarget(baseDir: string, target: string): string {
  const clean = target.replace(/^\/+/, "");
  if (target.startsWith("/")) return clean;
  if (!baseDir) return clean;
  const parts = `${baseDir}/${clean}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function normalizeSparseGrid(grid: string[][], sheetName: string, rowLimit = 100_000): { sheet: TableSheetData; truncated: boolean } {
  let lastNonEmptyRow = -1;
  let maxCols = 1;
  for (let r = 0; r < grid.length; r += 1) {
    const row = grid[r]!;
    let nonEmpty = false;
    for (let c = row.length - 1; c >= 0; c -= 1) {
      if ((row[c] ?? "") !== "") {
        nonEmpty = true;
        if (c + 1 > maxCols) maxCols = c + 1;
        break;
      }
    }
    if (nonEmpty) lastNonEmptyRow = r;
  }
  if (lastNonEmptyRow < 0) {
    return { sheet: { name: sheetName, columns: ["列 1"], rows: [] }, truncated: false };
  }
  const truncated = lastNonEmptyRow + 1 > rowLimit;
  const capped = grid.slice(0, Math.min(lastNonEmptyRow + 1, rowLimit)).map((r) => {
    const dense = new Array<string>(maxCols).fill("");
    for (let c = 0; c < Math.min(r.length, maxCols); c += 1) dense[c] = r[c] ?? "";
    return dense;
  });
  return { sheet: buildSheetFromRawRows(sheetName, capped), truncated };
}

export async function parseXlsxBuffer(bytes: Uint8Array): Promise<TablePreviewData> {
  const t0 = performance.now();
  const entries = await unzipEntries(
    bytes,
    (name) => name.startsWith("xl/") && name.endsWith(".xml") || name === "xl/_rels/workbook.xml.rels",
  );

  // 1. Parse shared strings
  const sharedStrings: string[] = [];
  const sstRaw = entries.get("xl/sharedStrings.xml");
  if (sstRaw) {
    const sstDoc = parseXmlNodes(UTF8_DECODER.decode(sstRaw));
    const sst = xmlFindFirst(sstDoc, "sst");
    for (const si of sst ? xmlChildren(sst, "si") : xmlFindAll(sstDoc, "si")) {
      sharedStrings.push(xmlText(si));
    }
  }

  // 2. Parse number format date flags
  const xfIsDate: boolean[] = [];
  const stylesRaw = entries.get("xl/styles.xml");
  if (stylesRaw) {
    const stylesDoc = parseXmlNodes(UTF8_DECODER.decode(stylesRaw));
    const customDateFmtIds = new Set<number>();
    for (const nf of xmlFindAll(stylesDoc, "numFmt")) {
      const id = Number.parseInt(nf.attrs.numFmtId ?? "", 10);
      const code = nf.attrs.formatCode ?? "";
      if (Number.isFinite(id) && looksLikeDateFormatCode(code)) customDateFmtIds.add(id);
    }
    const cellXfs = xmlFindFirst(stylesDoc, "cellXfs");
    if (cellXfs) {
      for (const xf of xmlChildren(cellXfs, "xf")) {
        const numFmtId = Number.parseInt(xf.attrs.numFmtId ?? "0", 10);
        xfIsDate.push(isBuiltinDateFormatId(numFmtId) || customDateFmtIds.has(numFmtId));
      }
    }
  }

  // 3. Map workbook sheets -> worksheet file paths
  const relTargets = new Map<string, string>();
  const relRaw = entries.get("xl/_rels/workbook.xml.rels");
  if (relRaw) {
    const relDoc = parseXmlNodes(UTF8_DECODER.decode(relRaw));
    for (const rel of xmlFindAll(relDoc, "Relationship")) {
      if (rel.attrs.Id && rel.attrs.Target) {
        relTargets.set(rel.attrs.Id, normalizeZipTarget("xl", rel.attrs.Target));
      }
    }
  }

  const sheetSpecs: Array<{ name: string; path: string }> = [];
  const wbRaw = entries.get("xl/workbook.xml");
  if (wbRaw) {
    const wbDoc = parseXmlNodes(UTF8_DECODER.decode(wbRaw));
    const sheets = xmlFindAll(wbDoc, "sheet");
    for (let i = 0; i < sheets.length; i += 1) {
      const s = sheets[i]!;
      const name = s.attrs.name || `Sheet${i + 1}`;
      const rid = s.attrs["r:id"] ?? s.attrs.id ?? "";
      const target = relTargets.get(rid) ?? `xl/worksheets/sheet${i + 1}.xml`;
      if (entries.has(target)) sheetSpecs.push({ name, path: target });
    }
  }
  if (sheetSpecs.length === 0) {
    const fallback = Array.from(entries.keys())
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    for (let i = 0; i < fallback.length; i += 1) {
      sheetSpecs.push({ name: `Sheet${i + 1}`, path: fallback[i]! });
    }
  }

  const parsedSheets: TableSheetData[] = [];
  let anyTruncated = false;

  for (const spec of sheetSpecs) {
    const rawSheet = entries.get(spec.path);
    if (!rawSheet) continue;
    const sheetDoc = parseXmlNodes(UTF8_DECODER.decode(rawSheet));
    const rowsNodes = xmlFindAll(sheetDoc, "row");
    const grid: string[][] = [];

    for (let ri = 0; ri < rowsNodes.length; ri += 1) {
      const rn = rowsNodes[ri]!;
      const rAttr = Number.parseInt(rn.attrs.r ?? "", 10);
      const rowIdx = Number.isFinite(rAttr) && rAttr > 0 ? rAttr - 1 : grid.length;
      while (grid.length <= rowIdx && grid.length < 100_005) grid.push([]);
      if (rowIdx >= 100_005) {
        anyTruncated = true;
        break;
      }
      const targetRow = grid[rowIdx]!;
      let nextCol = 0;
      for (const cNode of xmlChildren(rn, "c")) {
        const ref = cNode.attrs.r ?? "";
        const letters = /^[A-Za-z]+/.exec(ref)?.[0] ?? "";
        const colIdx = letters ? colLettersToIndex(letters) : nextCol;
        nextCol = colIdx + 1;
        if (colIdx > 2048) continue;
        while (targetRow.length <= colIdx) targetRow.push("");

        const cellType = cNode.attrs.t ?? "n";
        const styleIdx = Number.parseInt(cNode.attrs.s ?? "-1", 10);
        const vNode = xmlChildren(cNode, "v")[0];
        const vText = vNode ? xmlText(vNode) : "";

        let val = "";
        if (cellType === "s") {
          const sIdx = Number.parseInt(vText, 10);
          val = sharedStrings[sIdx] ?? "";
        } else if (cellType === "inlineStr") {
          const isNode = xmlChildren(cNode, "is")[0];
          val = isNode ? xmlText(isNode) : xmlText(cNode);
        } else if (cellType === "b") {
          val = vText === "1" ? "TRUE" : "FALSE";
        } else if (cellType === "str" || cellType === "e") {
          val = vText;
        } else {
          if (vText !== "" && styleIdx >= 0 && xfIsDate[styleIdx]) {
            const num = Number.parseFloat(vText);
            val = Number.isFinite(num) ? formatExcelSerialDate(num) : vText;
          } else {
            val = vText;
          }
        }
        targetRow[colIdx] = val;
      }
    }
    const normalized = normalizeSparseGrid(grid, spec.name);
    if (normalized.truncated) anyTruncated = true;
    parsedSheets.push(normalized.sheet);
  }

  return {
    sheets: parsedSheets.length ? parsedSheets : [{ name: "Sheet1", columns: ["列 1"], rows: [] }],
    truncated: anyTruncated,
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

export async function parseOdsBuffer(bytes: Uint8Array): Promise<TablePreviewData> {
  const t0 = performance.now();
  const entries = await unzipEntries(bytes, (name) => name === "content.xml");
  const contentRaw = entries.get("content.xml");
  if (!contentRaw) throw new Error("ODS 缺少 content.xml");
  const doc = parseXmlNodes(UTF8_DECODER.decode(contentRaw));
  const tableNodes = xmlFindAll(doc, "table");
  const sheets: TableSheetData[] = [];
  let anyTruncated = false;

  for (let ti = 0; ti < tableNodes.length; ti += 1) {
    const tbl = tableNodes[ti]!;
    const name = tbl.attrs.name || `Sheet${ti + 1}`;
    const grid: string[][] = [];
    for (const tr of xmlChildren(tbl, "table-row")) {
      const row: string[] = [];
      for (const tc of tr.children) {
        if (tc.local !== "table-cell" && tc.local !== "covered-table-cell") continue;
        const rep = Math.min(256, Math.max(1, Number.parseInt(tc.attrs["number-columns-repeated"] ?? "1", 10) || 1));
        const val =
          tc.attrs["date-value"] ??
          tc.attrs.value ??
          xmlChildren(tc, "p").map((p) => xmlText(p)).join("\n");
        if (!val && rep > 16) continue;
        for (let k = 0; k < rep && row.length < 1024; k += 1) row.push(val);
      }
      if (row.some((c) => c !== "")) grid.push(row);
      else if (grid.length > 0 && grid.length < 20_000) grid.push([]);
      if (grid.length >= 100_000) {
        anyTruncated = true;
        break;
      }
    }
    const normalized = normalizeSparseGrid(grid, name);
    if (normalized.truncated) anyTruncated = true;
    sheets.push(normalized.sheet);
  }

  return {
    sheets: sheets.length ? sheets : [{ name: "Sheet1", columns: ["列 1"], rows: [] }],
    truncated: anyTruncated,
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// OLE2 Compound File Binary Reader (shared by .xls and legacy .doc fallback)
// ---------------------------------------------------------------------------

function readOle2Streams(bytes: Uint8Array): Map<string, Uint8Array> | null {
  if (bytes.length < 512) return null;
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== sig[i]) return null;
  }

  const sectorShift = u16le(bytes, 30);
  const miniSectorShift = u16le(bytes, 32);
  const sectorSize = 1 << Math.min(12, Math.max(9, sectorShift));
  const miniSectorSize = 1 << Math.min(9, Math.max(6, miniSectorShift));
  const firstDirSect = i32le(bytes, 48);
  const miniStreamCutoff = u32le(bytes, 56) || 4096;
  const firstMiniFatSect = i32le(bytes, 60);
  const numDifat = u32le(bytes, 72);
  let nextDifat = i32le(bytes, 68);

  const sectorOffset = (sec: number) => 512 + sec * sectorSize;

  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const s = i32le(bytes, 76 + i * 4);
    if (s >= 0) fatSectors.push(s);
  }
  let difatLoops = 0;
  while (nextDifat >= 0 && difatLoops < Math.min(numDifat, 128)) {
    const off = sectorOffset(nextDifat);
    if (off + sectorSize > bytes.length) break;
    const entriesPerSect = sectorSize / 4 - 1;
    for (let i = 0; i < entriesPerSect; i += 1) {
      const s = i32le(bytes, off + i * 4);
      if (s >= 0) fatSectors.push(s);
    }
    nextDifat = i32le(bytes, off + entriesPerSect * 4);
    difatLoops += 1;
  }

  const fat: number[] = [];
  for (const fsIdx of fatSectors) {
    const off = sectorOffset(fsIdx);
    if (off + sectorSize > bytes.length) continue;
    for (let k = 0; k < sectorSize; k += 4) fat.push(i32le(bytes, off + k));
  }

  const readChain = (start: number, expectedLen?: number): Uint8Array => {
    const chunks: Uint8Array[] = [];
    let cur = start;
    const seen = new Set<number>();
    let total = 0;
    while (cur >= 0 && cur < fat.length && !seen.has(cur)) {
      seen.add(cur);
      const off = sectorOffset(cur);
      if (off >= bytes.length) break;
      const take = Math.min(sectorSize, bytes.length - off);
      chunks.push(bytes.subarray(off, off + take));
      total += take;
      if (expectedLen !== undefined && total >= expectedLen) break;
      cur = fat[cur]!;
    }
    const out = new Uint8Array(expectedLen !== undefined ? Math.min(total, expectedLen) : total);
    let pos = 0;
    for (const c of chunks) {
      const rem = out.length - pos;
      if (rem <= 0) break;
      const take = Math.min(c.length, rem);
      out.set(c.subarray(0, take), pos);
      pos += take;
    }
    return out;
  };

  const dirBytes = readChain(firstDirSect);
  const entries: Array<{ name: string; type: number; start: number; size: number }> = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = Math.min(64, u16le(dirBytes, off + 64));
    const type = dirBytes[off + 66]!;
    if (type === 0 || nameLen < 2) continue;
    const name = UTF16LE_DECODER.decode(dirBytes.subarray(off, off + nameLen - 2));
    const start = i32le(dirBytes, off + 116);
    const size = u32le(dirBytes, off + 120);
    entries.push({ name, type, start, size });
  }

  const rootEntry = entries.find((e) => e.type === 5);
  const miniStream = rootEntry && rootEntry.start >= 0 ? readChain(rootEntry.start, rootEntry.size) : new Uint8Array(0);
  const miniFatBytes = firstMiniFatSect >= 0 ? readChain(firstMiniFatSect) : new Uint8Array(0);
  const miniFat: number[] = [];
  for (let k = 0; k + 4 <= miniFatBytes.length; k += 4) miniFat.push(i32le(miniFatBytes, k));

  const readMiniChain = (start: number, expectedLen: number): Uint8Array => {
    const out = new Uint8Array(expectedLen);
    let cur = start;
    let pos = 0;
    const seen = new Set<number>();
    while (cur >= 0 && cur < miniFat.length && pos < expectedLen && !seen.has(cur)) {
      seen.add(cur);
      const off = cur * miniSectorSize;
      if (off >= miniStream.length) break;
      const take = Math.min(miniSectorSize, miniStream.length - off, expectedLen - pos);
      out.set(miniStream.subarray(off, off + take), pos);
      pos += take;
      cur = miniFat[cur]!;
    }
    return out;
  };

  const streams = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.type !== 2 || e.start < 0 || e.size === 0) continue;
    const data = e.size < miniStreamCutoff && miniStream.length > 0
      ? readMiniChain(e.start, e.size)
      : readChain(e.start, e.size);
    streams.set(e.name, data);
  }
  return streams;
}

function decodeRkNumber(rk: number): number {
  const div100 = (rk & 0x01) !== 0;
  const isInt = (rk & 0x02) !== 0;
  let val: number;
  if (isInt) {
    val = rk >> 2;
  } else {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, 0, true);
    dv.setUint32(4, rk & 0xfffffffc, true);
    val = dv.getFloat64(0, true);
  }
  return div100 ? val / 100 : val;
}

function readBiffString(stream: Uint8Array, pos: number, lenBytes: 1 | 2): { text: string; next: number } {
  if (pos + lenBytes >= stream.length) return { text: "", next: stream.length };
  const charCount = lenBytes === 2 ? u16le(stream, pos) : stream[pos]!;
  pos += lenBytes;
  if (pos >= stream.length) return { text: "", next: stream.length };
  const flags = stream[pos]!;
  pos += 1;
  const highByte = (flags & 0x01) !== 0;
  const hasRich = (flags & 0x08) !== 0;
  const hasExt = (flags & 0x04) !== 0;
  let richRuns = 0;
  let extSize = 0;
  if (hasRich) {
    richRuns = u16le(stream, pos);
    pos += 2;
  }
  if (hasExt) {
    extSize = u32le(stream, pos);
    pos += 4;
  }
  const byteLen = charCount * (highByte ? 2 : 1);
  const end = Math.min(stream.length, pos + byteLen);
  const raw = stream.subarray(pos, end);
  const text = highByte ? UTF16LE_DECODER.decode(raw) : LATIN1_DECODER.decode(raw);
  return { text, next: end + richRuns * 4 + extSize };
}

export function parseLegacyXlsBuffer(bytes: Uint8Array): TablePreviewData {
  const t0 = performance.now();
  // Detect disguised HTML/XML .xls exports quickly
  const headText = UTF8_DECODER.decode(bytes.subarray(0, Math.min(512, bytes.length))).trimStart();
  if (headText.startsWith("<")) {
    const full = UTF8_DECODER.decode(bytes);
    if (/<tr\b/i.test(full)) {
      const grid: string[][] = [];
      for (const trMatch of full.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const row: string[] = [];
        for (const tdMatch of trMatch[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
          row.push(decodeXmlEntities(tdMatch[1]!.replace(/<[^>]+>/g, "").trim()));
        }
        if (row.length > 0) grid.push(row);
      }
      const normalized = normalizeSparseGrid(grid, "Sheet1");
      return { sheets: [normalized.sheet], truncated: normalized.truncated, parseMs: Number((performance.now() - t0).toFixed(2)) };
    }
    if (/<Worksheet\b/i.test(full)) {
      const doc = parseXmlNodes(full);
      const sheets: TableSheetData[] = [];
      for (const ws of xmlFindAll(doc, "Worksheet")) {
        const grid: string[][] = [];
        for (const r of xmlFindAll(ws, "Row")) {
          const row = xmlChildren(r, "Cell").map((c) => xmlText(c).trim());
          grid.push(row);
        }
        sheets.push(normalizeSparseGrid(grid, ws.attrs.Name || `Sheet${sheets.length + 1}`).sheet);
      }
      if (sheets.length > 0) {
        return { sheets, truncated: false, parseMs: Number((performance.now() - t0).toFixed(2)) };
      }
    }
  }

  const streams = readOle2Streams(bytes);
  const wb = streams?.get("Workbook") ?? streams?.get("Book");
  if (!wb || wb.length < 4) {
    throw new Error("无法解析该 .xls 文件结构");
  }

  // Gather records first so SST + CONTINUE blocks can be decoded cleanly
  const records: Array<{ id: number; off: number; data: Uint8Array }> = [];
  let p = 0;
  while (p + 4 <= wb.length) {
    const id = u16le(wb, p);
    const len = u16le(wb, p + 2);
    p += 4;
    if (p + len > wb.length) break;
    records.push({ id, off: p - 4, data: wb.subarray(p, p + len) });
    p += len;
  }

  const sheetDefs: Array<{ name: string; offset: number }> = [];
  const sst: string[] = [];

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (rec.id === 0x0085 && rec.data.length >= 8) {
      const offset = u32le(rec.data, 0);
      const { text } = readBiffString(rec.data, 6, 1);
      sheetDefs.push({ name: text || `Sheet${sheetDefs.length + 1}`, offset });
    } else if (rec.id === 0x00fc && rec.data.length >= 8) {
      // Stitch SST + trailing CONTINUE blocks
      const uniqueCount = u32le(rec.data, 4);
      const segs = [rec.data.subarray(8)];
      while (i + 1 < records.length && records[i + 1]!.id === 0x003c) {
        i += 1;
        segs.push(records[i]!.data);
      }
      const total = segs.reduce((a, s) => a + s.length, 0);
      const merged = new Uint8Array(total);
      let mp = 0;
      for (const s of segs) {
        merged.set(s, mp);
        mp += s.length;
      }
      let cur = 0;
      for (let sIdx = 0; sIdx < uniqueCount && cur < merged.length; sIdx += 1) {
        const res = readBiffString(merged, cur, 2);
        sst.push(res.text);
        cur = res.next;
      }
    }
  }

  const sheetDataList: TableSheetData[] = [];
  const parseSheetFromRecIdx = (startRecIdx: number, sheetName: string): { sheet: TableSheetData; truncated: boolean } => {
    const grid: string[][] = [];
    const put = (r: number, c: number, v: string) => {
      if (r >= 100_000 || c >= 1024) return;
      while (grid.length <= r) grid.push([]);
      while (grid[r]!.length <= c) grid[r]!.push("");
      grid[r]![c] = v;
    };
    let lastFormulaCell: { r: number; c: number } | null = null;
    for (let k = startRecIdx; k < records.length; k += 1) {
      const rec = records[k]!;
      if (rec.id === 0x000a) break; // EOF
      if (rec.id === 0x00fd && rec.data.length >= 10) {
        put(u16le(rec.data, 0), u16le(rec.data, 2), sst[u32le(rec.data, 6)] ?? "");
      } else if (rec.id === 0x0204 && rec.data.length >= 8) {
        const { text } = readBiffString(rec.data, 6, 2);
        put(u16le(rec.data, 0), u16le(rec.data, 2), text);
      } else if (rec.id === 0x0203 && rec.data.length >= 14) {
        put(u16le(rec.data, 0), u16le(rec.data, 2), String(f64le(rec.data, 6)));
      } else if (rec.id === 0x027e && rec.data.length >= 10) {
        put(u16le(rec.data, 0), u16le(rec.data, 2), String(decodeRkNumber(i32le(rec.data, 6))));
      } else if (rec.id === 0x00bd && rec.data.length >= 12) {
        const r = u16le(rec.data, 0);
        const cFirst = u16le(rec.data, 2);
        const count = Math.floor((rec.data.length - 6) / 6);
        for (let m = 0; m < count; m += 1) {
          put(r, cFirst + m, String(decodeRkNumber(i32le(rec.data, 4 + m * 6 + 2))));
        }
      } else if (rec.id === 0x0006 && rec.data.length >= 14) {
        const r = u16le(rec.data, 0);
        const c = u16le(rec.data, 2);
        if (rec.data[12] === 0xff && rec.data[13] === 0xff && rec.data[6] === 0) {
          lastFormulaCell = { r, c };
        } else {
          put(r, c, String(f64le(rec.data, 6)));
          lastFormulaCell = null;
        }
      } else if (rec.id === 0x0207 && lastFormulaCell) {
        const { text } = readBiffString(rec.data, 0, 2);
        put(lastFormulaCell.r, lastFormulaCell.c, text);
        lastFormulaCell = null;
      }
    }
    return normalizeSparseGrid(grid, sheetName);
  };

  let anyTruncated = false;
  for (const def of sheetDefs) {
    const startIdx = records.findIndex((r) => r.off >= def.offset);
    if (startIdx >= 0) {
      const parsed = parseSheetFromRecIdx(startIdx, def.name);
      if (parsed.truncated) anyTruncated = true;
      sheetDataList.push(parsed.sheet);
    }
  }

  return {
    sheets: sheetDataList.length ? sheetDataList : [{ name: "Sheet1", columns: ["列 1"], rows: [] }],
    truncated: anyTruncated,
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// DOCX / ODT / RTF / Legacy DOC Document Parsers
// ---------------------------------------------------------------------------

function sniffImageMimeForOffice(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "bmp") return "image/bmp";
  return "image/png";
}

function docHeadingLevel(styleId: string): (1 | 2 | 3 | 4 | 5 | 6) | null {
  const lower = styleId.toLowerCase();
  if (lower === "title") return 1;
  if (lower === "subtitle") return 2;
  const m = /(?:heading|标题)\s*([1-6])$/i.exec(lower) ?? /^h([1-6])$/i.exec(lower);
  if (!m) return null;
  return Number.parseInt(m[1]!, 10) as 1 | 2 | 3 | 4 | 5 | 6;
}

function normalizeDocColor(raw: string | undefined): string | undefined {
  if (!raw || raw.toLowerCase() === "auto") return undefined;
  const clean = raw.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return `#${clean}`;
  return undefined;
}

function parseDocxRun(rNode: XmlNode, href?: string): DocRun[] {
  const rPr = xmlChildren(rNode, "rPr")[0];
  let bold = false;
  let italic = false;
  let underline = false;
  let strike = false;
  let code = false;
  let color: string | undefined;

  if (rPr) {
    const bNode = xmlChildren(rPr, "b")[0];
    if (bNode && bNode.attrs.val !== "0" && bNode.attrs.val !== "false") bold = true;
    const iNode = xmlChildren(rPr, "i")[0];
    if (iNode && iNode.attrs.val !== "0" && iNode.attrs.val !== "false") italic = true;
    const uNode = xmlChildren(rPr, "u")[0];
    if (uNode && uNode.attrs.val !== "none") underline = true;
    const sNode = xmlChildren(rPr, "strike")[0] ?? xmlChildren(rPr, "dstrike")[0];
    if (sNode && sNode.attrs.val !== "0" && sNode.attrs.val !== "false") strike = true;
    const colNode = xmlChildren(rPr, "color")[0];
    color = normalizeDocColor(colNode?.attrs.val);
    const fonts = xmlChildren(rPr, "rFonts")[0];
    const fontName = fonts?.attrs.ascii || fonts?.attrs.hAnsi || "";
    if (/mono|courier|consolas|menlo|code/i.test(fontName)) code = true;
  }

  let text = "";
  for (const child of rNode.children) {
    if (child.local === "t" || child.local === "delText") text += xmlText(child);
    else if (child.local === "tab") text += "\t";
    else if (child.local === "br" || child.local === "cr") text += "\n";
  }
  if (!text) return [];
  return [{
    text,
    ...(bold ? { bold } : {}),
    ...(italic ? { italic } : {}),
    ...(underline ? { underline } : {}),
    ...(strike ? { strike } : {}),
    ...(code ? { code } : {}),
    ...(color ? { color } : {}),
    ...(href ? { href } : {}),
  }];
}

export async function parseDocxBuffer(bytes: Uint8Array): Promise<DocPreviewData> {
  const t0 = performance.now();
  const entries = await unzipEntries(
    bytes,
    (name) =>
      name === "word/document.xml" ||
      name === "word/_rels/document.xml.rels" ||
      name === "word/numbering.xml" ||
      name.startsWith("word/media/"),
  );

  const rels = new Map<string, { target: string; external: boolean }>();
  const relRaw = entries.get("word/_rels/document.xml.rels");
  if (relRaw) {
    const relDoc = parseXmlNodes(UTF8_DECODER.decode(relRaw));
    for (const r of xmlFindAll(relDoc, "Relationship")) {
      if (r.attrs.Id && r.attrs.Target) {
        rels.set(r.attrs.Id, {
          target: r.attrs.Target,
          external: r.attrs.TargetMode === "External",
        });
      }
    }
  }

  const orderedNumIds = new Set<string>();
  const numRaw = entries.get("word/numbering.xml");
  if (numRaw) {
    const numDoc = parseXmlNodes(UTF8_DECODER.decode(numRaw));
    const orderedAbstractIds = new Set<string>();
    for (const abs of xmlFindAll(numDoc, "abstractNum")) {
      const fmt = xmlFindFirst(abs, "numFmt")?.attrs.val ?? "";
      if (fmt && fmt !== "bullet") orderedAbstractIds.add(abs.attrs.abstractNumId ?? "");
    }
    for (const num of xmlFindAll(numDoc, "num")) {
      const absId = xmlFindFirst(num, "abstractNumId")?.attrs.val ?? "";
      if (orderedAbstractIds.has(absId) && num.attrs.numId) orderedNumIds.add(num.attrs.numId);
    }
  }

  const mediaUrls: string[] = [];
  const mediaMap = new Map<string, string>();
  for (const [name, data] of entries) {
    if (!name.startsWith("word/media/")) continue;
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([copy], { type: sniffImageMimeForOffice(name) }));
    mediaUrls.push(url);
    mediaMap.set(name, url);
  }

  const docRaw = entries.get("word/document.xml");
  if (!docRaw) throw new Error("DOCX 缺少 word/document.xml");
  const xmlDoc = parseXmlNodes(UTF8_DECODER.decode(docRaw));
  const body = xmlFindFirst(xmlDoc, "body") ?? xmlDoc;

  const parseParagraph = (pNode: XmlNode, outBlocks: DocBlock[]) => {
    const pPr = xmlChildren(pNode, "pPr")[0];
    const styleId = pPr ? (xmlChildren(pPr, "pStyle")[0]?.attrs.val ?? "") : "";
    const level = docHeadingLevel(styleId);
    const jc = pPr ? xmlChildren(pPr, "jc")[0]?.attrs.val : undefined;
    const align: "left" | "center" | "right" | undefined =
      jc === "center" ? "center" : jc === "right" ? "right" : undefined;

    const numPr = pPr ? xmlChildren(pPr, "numPr")[0] : undefined;
    const listLevel = numPr ? Number.parseInt(xmlChildren(numPr, "ilvl")[0]?.attrs.val ?? "0", 10) : undefined;
    const numId = numPr ? xmlChildren(numPr, "numId")[0]?.attrs.val : undefined;
    const ordered = numId ? orderedNumIds.has(numId) : undefined;

    const runs: DocRun[] = [];
    const embeddedImages: string[] = [];

    for (const child of pNode.children) {
      if (child.local === "r") {
        runs.push(...parseDocxRun(child));
        for (const blip of xmlFindAll(child, "blip")) {
          const rid = blip.attrs.embed ?? blip.attrs["r:embed"] ?? "";
          const rel = rels.get(rid);
          if (rel && !rel.external) {
            const full = normalizeZipTarget("word", rel.target);
            const url = mediaMap.get(full);
            if (url) embeddedImages.push(url);
          }
        }
      } else if (child.local === "hyperlink") {
        const rid = child.attrs.id ?? child.attrs["r:id"] ?? "";
        const rel = rels.get(rid);
        const href = rel?.external ? rel.target : undefined;
        for (const hr of xmlChildren(child, "r")) runs.push(...parseDocxRun(hr, href));
      }
    }

    if (runs.length > 0) {
      if (level) {
        outBlocks.push({ kind: "heading", level, runs });
      } else {
        outBlocks.push({
          kind: "paragraph",
          runs,
          ...(align ? { align } : {}),
          ...(listLevel !== undefined ? { listLevel, ordered } : {}),
        });
      }
    } else if (embeddedImages.length === 0 && !level) {
      outBlocks.push({ kind: "paragraph", runs: [{ text: "" }] });
    }
    for (const src of embeddedImages) {
      outBlocks.push({ kind: "image", src });
    }
  };

  const blocks: DocBlock[] = [];
  for (const child of body.children) {
    if (child.local === "p") {
      parseParagraph(child, blocks);
    } else if (child.local === "tbl") {
      const rows: Array<Array<{ runs: DocRun[]; colspan?: number }>> = [];
      for (const tr of xmlChildren(child, "tr")) {
        const cells: Array<{ runs: DocRun[]; colspan?: number }> = [];
        for (const tc of xmlChildren(tr, "tc")) {
          const tcPr = xmlChildren(tc, "tcPr")[0];
          const spanRaw = tcPr ? xmlChildren(tcPr, "gridSpan")[0]?.attrs.val : undefined;
          const colspan = spanRaw ? Math.max(1, Number.parseInt(spanRaw, 10) || 1) : undefined;
          const cellRuns: DocRun[] = [];
          const paras = xmlChildren(tc, "p");
          for (let pi = 0; pi < paras.length; pi += 1) {
            if (pi > 0) cellRuns.push({ text: "\n" });
            for (const c of paras[pi]!.children) {
              if (c.local === "r") cellRuns.push(...parseDocxRun(c));
              else if (c.local === "hyperlink") {
                const rid = c.attrs.id ?? c.attrs["r:id"] ?? "";
                const href = rels.get(rid)?.external ? rels.get(rid)!.target : undefined;
                for (const hr of xmlChildren(c, "r")) cellRuns.push(...parseDocxRun(hr, href));
              }
            }
          }
          cells.push({ runs: cellRuns, ...(colspan && colspan > 1 ? { colspan } : {}) });
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length > 0) blocks.push({ kind: "table", rows });
    }
  }

  return {
    blocks,
    mediaUrls,
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

export async function parseOdtBuffer(bytes: Uint8Array): Promise<DocPreviewData> {
  const t0 = performance.now();
  const entries = await unzipEntries(
    bytes,
    (name) => name === "content.xml" || name.startsWith("Pictures/"),
  );
  const mediaUrls: string[] = [];
  const mediaMap = new Map<string, string>();
  for (const [name, data] of entries) {
    if (!name.startsWith("Pictures/")) continue;
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([copy], { type: sniffImageMimeForOffice(name) }));
    mediaUrls.push(url);
    mediaMap.set(name, url);
  }
  const contentRaw = entries.get("content.xml");
  if (!contentRaw) throw new Error("ODT 缺少 content.xml");
  const doc = parseXmlNodes(UTF8_DECODER.decode(contentRaw));
  const textBody = xmlFindFirst(doc, "text") ?? doc;
  const blocks: DocBlock[] = [];

  const walk = (container: XmlNode, listDepth?: number) => {
    for (const child of container.children) {
      if (child.local === "h") {
        const lvl = Math.min(6, Math.max(1, Number.parseInt(child.attrs["outline-level"] ?? "1", 10) || 1)) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push({ kind: "heading", level: lvl, runs: [{ text: xmlText(child) }] });
      } else if (child.local === "p") {
        const imgs = xmlFindAll(child, "image");
        const text = xmlText(child);
        if (text || imgs.length === 0) {
          blocks.push({
            kind: "paragraph",
            runs: [{ text }],
            ...(listDepth !== undefined ? { listLevel: listDepth } : {}),
          });
        }
        for (const im of imgs) {
          const href = im.attrs.href ?? im.attrs["xlink:href"] ?? "";
          const url = mediaMap.get(href.replace(/^\/+/, ""));
          if (url) blocks.push({ kind: "image", src: url });
        }
      } else if (child.local === "list") {
        for (const item of xmlChildren(child, "list-item")) {
          walk(item, listDepth === undefined ? 0 : listDepth + 1);
        }
      } else if (child.local === "table") {
        const rows = xmlChildren(child, "table-row").map((tr) =>
          xmlChildren(tr, "table-cell").map((tc) => ({ runs: [{ text: xmlText(tc).trim() }] })),
        );
        if (rows.length > 0) blocks.push({ kind: "table", rows });
      }
    }
  };
  walk(textBody);

  return {
    blocks,
    mediaUrls,
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

function decodeByteSeq(bytes: number[]): string {
  const arr = new Uint8Array(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(arr);
  } catch {
    return GB18030_DECODER.decode(arr);
  }
}

export function parseRtfText(raw: string): DocPreviewData {
  const t0 = performance.now();
  const blocks: DocBlock[] = [];
  let curRuns: DocRun[] = [];
  let hexBytes: number[] = [];

  type State = { bold: boolean; italic: boolean; underline: boolean; strike: boolean; skip: boolean; uc: number };
  const stack: State[] = [{ bold: false, italic: false, underline: false, strike: false, skip: false, uc: 1 }];
  let skipChars = 0;

  const flushHex = () => {
    if (hexBytes.length === 0) return;
    const top = stack[stack.length - 1]!;
    if (!top.skip) {
      curRuns.push({
        text: decodeByteSeq(hexBytes),
        ...(top.bold ? { bold: true } : {}),
        ...(top.italic ? { italic: true } : {}),
        ...(top.underline ? { underline: true } : {}),
        ...(top.strike ? { strike: true } : {}),
      });
    }
    hexBytes = [];
  };

  const appendChar = (ch: string) => {
    flushHex();
    const top = stack[stack.length - 1]!;
    if (top.skip) return;
    const prev = curRuns[curRuns.length - 1];
    if (
      prev &&
      Boolean(prev.bold) === top.bold &&
      Boolean(prev.italic) === top.italic &&
      Boolean(prev.underline) === top.underline &&
      Boolean(prev.strike) === top.strike
    ) {
      prev.text += ch;
    } else {
      curRuns.push({
        text: ch,
        ...(top.bold ? { bold: true } : {}),
        ...(top.italic ? { italic: true } : {}),
        ...(top.underline ? { underline: true } : {}),
        ...(top.strike ? { strike: true } : {}),
      });
    }
  };

  const flushPara = () => {
    flushHex();
    blocks.push({ kind: "paragraph", runs: curRuns.length ? curRuns : [{ text: "" }] });
    curRuns = [];
  };

  const skipDest = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer", "fldinst"]);
  let i = 0;
  const len = raw.length;
  while (i < len) {
    const ch = raw[i]!;
    if (skipChars > 0 && ch !== "\\" && ch !== "{" && ch !== "}" && ch !== "\r" && ch !== "\n") {
      skipChars -= 1;
      i += 1;
      continue;
    }
    if (ch === "{") {
      flushHex();
      const prev = stack[stack.length - 1]!;
      stack.push({ ...prev });
      i += 1;
      continue;
    }
    if (ch === "}") {
      flushHex();
      if (stack.length > 1) stack.pop();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      if (i >= len) break;
      const next = raw[i]!;
      if (next === "\\" || next === "{" || next === "}") {
        appendChar(next);
        i += 1;
        continue;
      }
      if (next === "*") {
        stack[stack.length - 1]!.skip = true;
        i += 1;
        continue;
      }
      if (next === "'") {
        const hex = raw.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          hexBytes.push(Number.parseInt(hex, 16));
          i += 3;
          continue;
        }
      }
      if (next === "~") {
        appendChar(" ");
        i += 1;
        continue;
      }
      if (next === "\n" || next === "\r") {
        flushPara();
        i += 1;
        continue;
      }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(raw.slice(i, i + 40));
      if (m) {
        const word = m[1]!;
        const param = m[2] !== undefined ? Number.parseInt(m[2], 10) : undefined;
        i += m[0].length;
        const top = stack[stack.length - 1]!;
        if (skipDest.has(word)) {
          top.skip = true;
        } else if (word === "par" || word === "line") {
          if (!top.skip) flushPara();
        } else if (word === "tab") {
          appendChar("\t");
        } else if (word === "b") {
          top.bold = param !== 0;
        } else if (word === "i") {
          top.italic = param !== 0;
        } else if (word === "ul") {
          top.underline = param !== 0;
        } else if (word === "ulnone") {
          top.underline = false;
        } else if (word === "strike") {
          top.strike = param !== 0;
        } else if (word === "uc" && param !== undefined) {
          top.uc = Math.max(0, param);
        } else if (word === "u" && param !== undefined) {
          const cp = param < 0 ? 65536 + param : param;
          if (cp > 0) appendChar(String.fromCodePoint(cp));
          skipChars = top.uc;
        }
        continue;
      }
      i += 1;
      continue;
    }
    appendChar(ch);
    i += 1;
  }
  flushHex();
  if (curRuns.length > 0) flushPara();

  return {
    blocks,
    mediaUrls: [],
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

/** Fallback text extractor for binary `.doc` when macOS `textutil` previewHtml is unavailable. */
export function parseLegacyDocFallback(bytes: Uint8Array): DocPreviewData {
  const t0 = performance.now();
  const streams = readOle2Streams(bytes);
  const wd = streams?.get("WordDocument");
  let extracted = "";

  if (wd && wd.length >= 0x200) {
    const flags = u16le(wd, 10);
    const tableName = (flags & 0x0200) !== 0 ? "1Table" : "0Table";
    const tbl = streams?.get(tableName);
    if (tbl && wd.length >= 0x1aa) {
      const fcClx = u32le(wd, 0x1a2);
      const lcbClx = u32le(wd, 0x1a6);
      if (fcClx + lcbClx <= tbl.length && lcbClx > 0) {
        let p = fcClx;
        const end = fcClx + lcbClx;
        while (p < end && tbl[p] === 0x01) {
          if (p + 3 > end) break;
          const cb = u16le(tbl, p + 1);
          p += 3 + cb;
        }
        if (p + 5 <= end && tbl[p] === 0x02) {
          const pcdSize = u32le(tbl, p + 1);
          const pcdStart = p + 5;
          const pieceCount = Math.floor((pcdSize - 4) / 12);
          if (pieceCount > 0 && pcdStart + (pieceCount + 1) * 4 + pieceCount * 8 <= tbl.length) {
            const chunks: string[] = [];
            const cpArrayOff = pcdStart;
            const pcdArrayOff = pcdStart + (pieceCount + 1) * 4;
            for (let pi = 0; pi < pieceCount; pi += 1) {
              const cpStart = u32le(tbl, cpArrayOff + pi * 4);
              const cpEnd = u32le(tbl, cpArrayOff + (pi + 1) * 4);
              const charCount = Math.max(0, cpEnd - cpStart);
              const rawFc = u32le(tbl, pcdArrayOff + pi * 8 + 2);
              const isCompressed = (rawFc & 0x40000000) !== 0;
              const fc = isCompressed ? (rawFc & ~0x40000000) >>> 1 : rawFc;
              const byteCount = charCount * (isCompressed ? 1 : 2);
              if (fc + byteCount <= wd.length) {
                const slice = wd.subarray(fc, fc + byteCount);
                chunks.push(isCompressed ? LATIN1_DECODER.decode(slice) : UTF16LE_DECODER.decode(slice));
              }
            }
            extracted = chunks.join("");
          }
        }
      }
    }
  }

  if (!extracted) {
    // Fallback UTF-8/HTML check (e.g. misnamed HTML `.doc`)
    const text = UTF8_DECODER.decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
    if (/^\s*</.test(text)) {
      extracted = UTF8_DECODER.decode(bytes).replace(/<[^>]+>/g, "\n");
    }
  }

  const lines = extracted
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trimEnd())
    .filter((l, idx, arr) => l.length > 0 || (idx > 0 && arr[idx - 1]!.length > 0));

  return {
    blocks: lines.slice(0, 5000).map((line) => ({ kind: "paragraph", runs: [{ text: line }] })),
    mediaUrls: [],
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// PPTX Presentation Parser & PDF Page Counter
// ---------------------------------------------------------------------------

export async function parsePptxBuffer(bytes: Uint8Array): Promise<SlidePreviewData> {
  const t0 = performance.now();
  const entries = await unzipEntries(
    bytes,
    (name) =>
      /^ppt\/slides\/slide\d+\.xml$/i.test(name) ||
      /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/i.test(name) ||
      name.startsWith("ppt/media/"),
  );

  const mediaUrls: string[] = [];
  const mediaMap = new Map<string, string>();
  for (const [name, data] of entries) {
    if (!name.startsWith("ppt/media/")) continue;
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([copy], { type: sniffImageMimeForOffice(name) }));
    mediaUrls.push(url);
    mediaMap.set(name, url);
  }

  const slideNames = Array.from(entries.keys())
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
    .sort((a, b) => {
      const na = Number.parseInt(/slide(\d+)\.xml/i.exec(a)?.[1] ?? "0", 10);
      const nb = Number.parseInt(/slide(\d+)\.xml/i.exec(b)?.[1] ?? "0", 10);
      return na - nb;
    });

  const slides: SlidePreviewItem[] = [];
  for (let i = 0; i < slideNames.length; i += 1) {
    const sPath = slideNames[i]!;
    const idxMatch = /slide(\d+)\.xml/i.exec(sPath);
    const index = idxMatch ? Number.parseInt(idxMatch[1]!, 10) : i + 1;

    const rels = new Map<string, string>();
    const relPath = `ppt/slides/_rels/slide${index}.xml.rels`;
    const relRaw = entries.get(relPath);
    if (relRaw) {
      const relDoc = parseXmlNodes(UTF8_DECODER.decode(relRaw));
      for (const rel of xmlFindAll(relDoc, "Relationship")) {
        if (rel.attrs.Id && rel.attrs.Target) {
          rels.set(rel.attrs.Id, normalizeZipTarget("ppt/slides", rel.attrs.Target));
        }
      }
    }

    const sDoc = parseXmlNodes(UTF8_DECODER.decode(entries.get(sPath)!));
    let title = "";
    const bullets: string[] = [];
    for (const sp of xmlFindAll(sDoc, "sp")) {
      const phType = xmlFindFirst(sp, "ph")?.attrs.type ?? "";
      const paras = xmlFindAll(sp, "p")
        .map((p) => xmlText(p).trim())
        .filter(Boolean);
      if (paras.length === 0) continue;
      if (!title && (phType === "title" || phType === "ctrTitle" || phType === "subTitle")) {
        title = paras[0]!;
        bullets.push(...paras.slice(1));
      } else {
        bullets.push(...paras);
      }
    }
    if (!title && bullets.length > 0) {
      title = bullets.shift()!;
    }

    const tables: string[][][] = xmlFindAll(sDoc, "tbl").map((tbl) =>
      xmlChildren(tbl, "tr").map((tr) =>
        xmlChildren(tr, "tc").map((tc) => xmlText(tc).trim()),
      ),
    );

    const images: string[] = [];
    for (const blip of xmlFindAll(sDoc, "blip")) {
      const rid = blip.attrs.embed ?? blip.attrs["r:embed"] ?? "";
      const target = rels.get(rid);
      const url = target ? mediaMap.get(target) : undefined;
      if (url && !images.includes(url)) images.push(url);
    }

    slides.push({
      index,
      title: title || `第 ${index} 页`,
      bullets,
      tables,
      images,
    });
  }

  return {
    slides,
    mediaUrls,
    parseMs: Number((performance.now() - t0).toFixed(2)),
  };
}

/** Fast O(N) byte scan estimating PDF page count without spawning a heavy PDF worker. */
export function estimatePdfPages(bytes: Uint8Array): number | null {
  if (bytes.length < 16) return null;
  const text = LATIN1_DECODER.decode(bytes);
  const matches = text.match(/\/Type\s*\/Page(?![A-Za-z0-9_])/g);
  return matches && matches.length > 0 ? matches.length : null;
}

/** Formats media playback timestamp as `MM:SS.cc` or `HH:MM:SS.cc`. */
export function formatMediaTimecode(seconds: number, withCentis = true): string {
  if (!Number.isFinite(seconds) || seconds < 0) return withCentis ? "00:00.00" : "00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const tail = withCentis ? `.${String(cs).padStart(2, "0")}` : "";
  return hrs > 0 ? `${String(hrs).padStart(2, "0")}:${mm}:${ss}${tail}` : `${mm}:${ss}${tail}`;
}

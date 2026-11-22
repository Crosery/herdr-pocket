import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  estimatePdfPages,
  formatMediaTimecode,
  parseDelimitedTable,
  parseDocxBuffer,
  parseJsonTable,
  parsePptxBuffer,
  parseRtfText,
  parseXlsxBuffer,
  unzipEntries,
} from "../src/lib/filePreview";

/** Builds an in-memory PKZIP buffer with raw-deflated entries for fast OOXML tests. */
function makeZip(files: Record<string, string>): Uint8Array {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const comp = deflateRawSync(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    localChunks.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    cdChunks.push(cdh, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const cdSize = cdChunks.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...localChunks, ...cdChunks, eocd]));
}

test("parseDelimitedTable parses RFC 4180 CSV, auto-sniffs delimiters, and handles 20k rows in < 50ms", () => {
  const csv = '\uFEFFname,note,score\n"Alice, A.","said ""hi""\nline2",98.5\nBob,ok,100\n';
  const parsed = parseDelimitedTable(csv);
  assert.equal(parsed.sheets.length, 1);
  assert.deepEqual(parsed.sheets[0]!.columns, ["name", "note", "score"]);
  assert.deepEqual(parsed.sheets[0]!.rows, [
    ["Alice, A.", 'said "hi"\nline2', "98.5"],
    ["Bob", "ok", "100"],
  ]);

  const semi = parseDelimitedTable("id;city;total\n1;Shanghai;42\n2;Beijing;88\n");
  assert.deepEqual(semi.sheets[0]!.columns, ["id", "city", "total"]);
  assert.deepEqual(semi.sheets[0]!.rows[0], ["1", "Shanghai", "42"]);

  const lines = ["id,val,tag"];
  for (let i = 0; i < 20_000; i += 1) lines.push(`${i},row_${i},tag_${i % 7}`);
  const big = parseDelimitedTable(lines.join("\n"));
  assert.equal(big.sheets[0]!.rows.length, 20_000);
  assert.ok(big.parseMs < 50, `expected < 50ms for 20k CSV rows, got ${big.parseMs}ms`);
});

test("parseJsonTable converts JSONL and tabular JSON arrays while rejecting non-tabular objects", () => {
  const jsonl = '{"id":1,"name":"alpha"}\n{"id":2,"name":"beta","extra":true}\n';
  const t1 = parseJsonTable(jsonl, true)!;
  assert.deepEqual(t1.sheets[0]!.columns, ["id", "name", "extra"]);
  assert.deepEqual(t1.sheets[0]!.rows, [
    ["1", "alpha", ""],
    ["2", "beta", "true"],
  ]);

  const arrJson = JSON.stringify([
    { host: "mac-1", status: "online" },
    { host: "mac-2", status: "idle" },
  ]);
  const t2 = parseJsonTable(arrJson, false)!;
  assert.deepEqual(t2.sheets[0]!.columns, ["host", "status"]);
  assert.equal(t2.sheets[0]!.rows.length, 2);

  assert.equal(parseJsonTable('{"not":"an array"}', false), null);
});

test("unzipEntries + parseDocxBuffer extracts headings, styled runs, hyperlinks and tables rapidly", async () => {
  const docx = makeZip({
    "word/_rels/document.xml.rels":
      '<?xml version="1.0"?><Relationships><Relationship Id="rId5" Target="https://example.com" TargetMode="External"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目周报</w:t></w:r></w:p>
          <w:p>
            <w:r><w:rPr><w:b/><w:color w:val="D20F39"/></w:rPr><w:t>重点</w:t></w:r>
            <w:r><w:t xml:space="preserve"> 查看 </w:t></w:r>
            <w:hyperlink r:id="rId5"><w:r><w:t>官网</w:t></w:r></w:hyperlink>
          </w:p>
          <w:tbl>
            <w:tr><w:tc><w:p><w:r><w:t>模块</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>耗时</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>预览</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2 ms</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
        </w:body>
      </w:document>`,
  });

  const unzipped = await unzipEntries(docx);
  assert.ok(unzipped.has("word/document.xml"));

  const parsed = await parseDocxBuffer(docx);
  assert.ok(parsed.parseMs < 50);
  assert.equal(parsed.blocks.length, 3);
  assert.deepEqual(parsed.blocks[0], { kind: "heading", level: 1, runs: [{ text: "项目周报" }] });
  const p = parsed.blocks[1]!;
  assert.equal(p.kind, "paragraph");
  if (p.kind === "paragraph") {
    assert.equal(p.runs[0]!.bold, true);
    assert.equal(p.runs[0]!.color, "#D20F39");
    assert.equal(p.runs[2]!.href, "https://example.com");
  }
  const tbl = parsed.blocks[2]!;
  assert.equal(tbl.kind, "table");
  if (tbl.kind === "table") {
    assert.equal(tbl.rows.length, 2);
    assert.equal(tbl.rows[1]![1]!.runs[0]!.text, "2 ms");
  }
});

test("parseXlsxBuffer extracts multiple sheets, shared strings, inline strings and Excel serial dates", async () => {
  const xlsx = makeZip({
    "xl/workbook.xml": `<?xml version="1.0"?>
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="概览" sheetId="1" r:id="rId1"/>
          <sheet name="明细" sheetId="2" r:id="rId2"/>
        </sheets>
      </workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?>
      <Relationships>
        <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/>
      </Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0"?>
      <sst><si><t>日期</t></si><si><t>指标</t></si><si><t>延迟(ms)</t></si><si><t>首屏</t></si></sst>`,
    "xl/styles.xml": `<?xml version="1.0"?>
      <styleSheet>
        <cellXfs>
          <xf numFmtId="0"/>
          <xf numFmtId="14"/>
        </cellXfs>
      </styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?>
      <worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
        <row r="2"><c r="A2" s="1"><v>46000</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>4.2</v></c></row>
      </sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<?xml version="1.0"?>
      <worksheet><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>状态</t></is></c></row>
        <row r="2"><c r="A2" t="b"><v>1</v></c></row>
      </sheetData></worksheet>`,
  });

  const parsed = await parseXlsxBuffer(xlsx);
  assert.ok(parsed.parseMs < 50);
  assert.equal(parsed.sheets.length, 2);
  assert.equal(parsed.sheets[0]!.name, "概览");
  assert.deepEqual(parsed.sheets[0]!.columns, ["日期", "指标", "延迟(ms)"]);
  assert.deepEqual(parsed.sheets[0]!.rows, [["2025-12-09", "首屏", "4.2"]]);
  assert.equal(parsed.sheets[1]!.name, "明细");
  assert.deepEqual(parsed.sheets[1]!.columns, ["状态"]);
  assert.deepEqual(parsed.sheets[1]!.rows, [["TRUE"]]);
});

test("parsePptxBuffer and parseRtfText and estimatePdfPages + formatMediaTimecode work cleanly", async () => {
  const pptx = makeZip({
    "ppt/slides/slide1.xml": `<?xml version="1.0"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>发布汇报</a:t></a:r></a:p></p:txBody></p:sp>
          <p:sp><p:txBody><a:p><a:r><a:t>视频播放器完成</a:t></a:r></a:p><a:p><a:r><a:t>毫秒预览</a:t></a:r></a:p></p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>`,
  });
  const slides = await parsePptxBuffer(pptx);
  assert.equal(slides.slides.length, 1);
  assert.equal(slides.slides[0]!.title, "发布汇报");
  assert.deepEqual(slides.slides[0]!.bullets, ["视频播放器完成", "毫秒预览"]);

  const rtf = parseRtfText(String.raw`{\rtf1\ansi{\fonttbl\f0 Helvetica;}Hi \b 中文\u27979? \b0 ok\par Next\par}`);
  assert.equal(rtf.blocks.length, 2);
  if (rtf.blocks[0]!.kind === "paragraph") {
    assert.ok(rtf.blocks[0]!.runs.some((r) => r.bold && r.text.includes("中文测")));
  }

  const fakePdf = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Pages /Count 2 >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n", "latin1");
  assert.equal(estimatePdfPages(new Uint8Array(fakePdf)), 2);

  assert.equal(formatMediaTimecode(2.08), "00:02.08");
  assert.equal(formatMediaTimecode(3661.5), "01:01:01.50");
  assert.equal(formatMediaTimecode(-1), "00:00.00");
});

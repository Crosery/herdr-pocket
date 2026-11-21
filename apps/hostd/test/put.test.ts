import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PUT_LIMITS, sameMessage, splitFiles, textWithFiles, type Agent } from "@herdr-pocket/protocol";
import { checkFiles, putLocal, putThrough, safeName, KEEP_MS } from "../src/put.ts";
import { HcAdapter } from "../src/hc.ts";
import { Host } from "../src/host.ts";

/** Owner-only modes are a macOS/Linux thing; Windows keeps the files private by folder. */
const POSIX = process.platform !== "win32";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const jpeg = (name = "IMG_0001.jpg") => ({ name, mime: "image/jpeg", data: JPEG.toString("base64") });

test("terminal.put files: raster images checked by magic bytes, general media/files keep safe distinct extensions, limits enforced", () => {
  const ok = checkFiles([jpeg("照片 1.JPG"), { name: "../../etc/passwd.png", mime: "image/png", data: PNG.toString("base64") }, jpeg("照片 1.JPG")]);
  assert.deepEqual(
    ok.map((f) => [f.name, f.mime, f.bytes.length]),
    [
      ["1.jpg", "image/jpeg", JPEG.length],
      ["passwd.png", "image/png", PNG.length],
      ["1-2.jpg", "image/jpeg", JPEG.length],
    ],
  );
  assert.deepEqual(checkFiles([jpeg("IMG 1.jpg"), jpeg("IMG 1.jpg"), jpeg("IMG 1.jpg")]).map((f) => f.name), ["IMG-1.jpg", "IMG-1-2.jpg", "IMG-1-3.jpg"]);
  assert.equal(safeName("", "image/webp", 2), "image-3.webp");
  assert.equal(safeName("...", "image/gif", 0), "image-1.gif");
  assert.equal(safeName("Screenshot 2026-11-14 at 10.00.00.png", "image/jpeg", 0), "Screenshot-2026-11-14-at-10.00.00.jpg");

  // Non-image media and text/document files preserve extensions with digits too (e.g. .mp4).
  const media = checkFiles([
    { name: "brief.md", mime: "text/markdown", data: Buffer.from("# hi\n").toString("base64") },
    { name: "metrics.csv", mime: "text/csv", data: Buffer.from("a,b\n1,2\n").toString("base64") },
    { name: "报告.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") },
    { name: "clip.mp4", mime: "video/mp4", data: Buffer.from("ftyp").toString("base64") },
    { name: "clip.mp4", mime: "video/mp4", data: Buffer.from("ftyp").toString("base64") },
  ]);
  assert.deepEqual(media.map((m) => m.name), ["brief.md", "metrics.csv", "file-3.pdf", "clip.mp4", "clip-2.mp4"]);

  const refuses = (files: unknown, re: RegExp) => assert.throws(() => checkFiles(files), re);
  refuses(undefined, /没有收到文件/);
  refuses([], /没有收到文件/);
  refuses(Array.from({ length: PUT_LIMITS.files + 1 }, () => jpeg()), /一次最多发 6 个文件/);
  refuses([{ name: "a.txt", mime: "not a mime", data: Buffer.from("hi").toString("base64") }], /类型格式不对/);
  refuses([{ name: "a.png", mime: "image/png", data: JPEG.toString("base64") }], /内容和类型对不上/);
  refuses([{ name: "a.jpg", mime: "image/jpeg", data: "not base64!" }], /内容不对/);
  refuses([{ name: "a.jpg", mime: "image/jpeg", data: "" }], /内容不对/);
  const big = Buffer.alloc(PUT_LIMITS.fileBytes + 1, 0);
  JPEG.copy(big);
  refuses([{ name: "a.jpg", mime: "image/jpeg", data: big.toString("base64") }], /太大了/);
  const two = Buffer.alloc(Math.floor(PUT_LIMITS.totalBytes / 2) + 10, 0);
  JPEG.copy(two);
  refuses([{ name: "a.jpg", mime: "image/jpeg", data: two.toString("base64") }, { name: "b.jpg", mime: "image/jpeg", data: two.toString("base64") }], /加起来太大了/);
});

test("the message names each picture on a line of its own after the text", () => {
  assert.equal(textWithFiles("  看下这个报错 ", ["/a/1.jpg", "/a/2.png"]), "看下这个报错\n/a/1.jpg\n/a/2.png");
  assert.equal(textWithFiles("", ["/a/1.jpg"]), "/a/1.jpg");
});

test("splitFiles and sameMessage strip harness image marks without losing words or double-counting", () => {
  assert.deepEqual(splitFiles("看下这个报错\n/a/1.jpg\n/a/2.png"), {
    text: "看下这个报错",
    lines: ["/a/1.jpg", "/a/2.png"],
    count: 2,
  });
  assert.deepEqual(splitFiles("[Image #1]图片里面有什么\n[image]"), {
    text: "图片里面有什么",
    lines: ["[Image #1]"],
    count: 1,
  });
  assert.deepEqual(splitFiles("[Image #1] 第一部分 [Image #2] 第二部分\n[image]\n[image]"), {
    text: "第一部分 第二部分",
    lines: ["[Image #1]", "[Image #2]"],
    count: 2,
  });
  assert.deepEqual(splitFiles("[Image #1, 1568x958]  这几个去掉 [Image #2, 760x1280] 还有这里 [image] [image]"), {
    text: "这几个去掉 还有这里",
    lines: ["[Image #1, 1568x958]", "[Image #2, 760x1280]"],
    count: 2,
  });
  assert.deepEqual(splitFiles("[Image #1]\n[image]"), {
    text: "",
    lines: ["[Image #1]"],
    count: 1,
  });
  assert.deepEqual(splitFiles("第一段\n\n第二段"), {
    text: "第一段\n\n第二段",
    lines: [],
    count: 0,
  });

  assert.equal(sameMessage("[Image #1]图片里面有什么\n[image]", "图片里面有什么", true), true);
  assert.equal(sameMessage("[Image #1, 1568x958]  图片里面有什么\n[image]", "图片里面有什么", true), true);
  assert.equal(sameMessage("[Image #1] 第一行 [Image #2] 第二行\n[image]\n[image]", "第一行\n第二行", true), true);
  assert.equal(sameMessage("[Image #1]\n[image]", "", true), true);
  assert.equal(sameMessage("", "", true), false);
  assert.equal(sameMessage("测试完了再提交， 别直接推", "测试完了再提交，别直接推"), true);
  assert.equal(sameMessage("[Image #1]别的文字\n[image]", "图片里面有什么", true), false);
});

test("putThrough hands over an owner-only temporary copy and removes it afterwards", async () => {
  const seen: Array<{ file: string; mode: number; bytes: number }> = [];
  const paths = await putThrough(checkFiles([jpeg("a.jpg"), jpeg("b.jpg")]), async (file) => {
    seen.push({ file, mode: statSync(file).mode & 0o777, bytes: readFileSync(file).length });
    return `/landed/${basename(file)}`;
  });
  assert.deepEqual(paths, ["/landed/a.jpg", "/landed/b.jpg"]);
  assert.deepEqual(seen.map((s) => [POSIX ? s.mode : 0o600, s.bytes]), [[0o600, JPEG.length], [0o600, JPEG.length]]);
  assert.equal(statSync(dirname(seen[0]!.file), { throwIfNoEntry: false }), undefined, "temporary folder removed");

  // A failing put still cleans up.
  let tmp = "";
  await assert.rejects(
    putThrough(checkFiles([jpeg()]), async (file) => {
      tmp = file;
      throw new Error("hc put failed: no such terminal");
    }),
    /no such terminal/,
  );
  assert.equal(existsSync(tmp), false);
});

test("putLocal keeps pictures in an owner-only folder per terminal, never overwrites, drops week-old ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "hp-files-"));
  const now = Date.now();
  mkdirSync(join(root, "old"), { recursive: true });
  const stale = join(root, "old", "x.jpg");
  writeFileSync(stale, JPEG);
  utimesSync(stale, new Date(now - KEEP_MS - 60_000), new Date(now - KEEP_MS - 60_000));
  const first = await putLocal(checkFiles([jpeg("shot.jpg")]), "1/../p2", root, now);
  const again = await putLocal(checkFiles([jpeg("shot.jpg")]), "1/../p2", root, now);
  assert.equal(first[0], join(root, "1_.._p2", "shot.jpg"));
  assert.equal(again[0], join(root, "1_.._p2", "shot-2.jpg"));
  if (POSIX) {
    assert.equal(statSync(first[0]!).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(first[0]!)).mode & 0o777, 0o700);
  }
  assert.equal(existsSync(join(root, "old")), false, "old picture and its empty folder removed");
});

test("HcAdapter.put runs `hc put --json` and returns where the file landed", { skip: !POSIX && "shell-script fake" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-put-"));
  const bin = join(dir, "hc");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(join(dir, "args"))}\nprintf '{"bytes":10,"path":"/state/files/t7/a.jpg"}\\n'\n`);
  chmodSync(bin, 0o755);
  assert.equal(await new HcAdapter(bin).put("t7", "/tmp/x/a.jpg"), "/state/files/t7/a.jpg");
  assert.equal(readFileSync(join(dir, "args"), "utf8").trim(), "put --json t7 /tmp/x/a.jpg");
  writeFileSync(bin, "#!/bin/sh\necho \"error: unrecognized subcommand 'put'\" >&2\nexit 2\n");
  await assert.rejects(new HcAdapter(bin).put("t7", "/tmp/x/a.jpg"), /unrecognized subcommand/);
});

function agent(source: "hc" | "herdr"): Agent {
  return { key: `d/${source}:t1`, deviceId: "d", source, localId: "t1", harness: "claude-code", status: "idle", isShell: false, updatedAt: 1 };
}

test("terminal.put: checked pictures land beside the agent; an old hc and bad files say why; read-only refuses", async () => {
  const root = mkdtempSync(join(tmpdir(), "hp-host-files-"));
  const make = (readOnly = false) => {
    const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, readOnly, log: () => {} });
    const x = h as unknown as { handlers: Record<string, (p: unknown, from: string) => Promise<any>> };
    return { h, put: (params: unknown) => x.handlers["terminal.put"]!(params, "phone") };
  };
  const { h, put } = make();
  h.agents = [agent("hc")];
  const got: string[] = [];
  h.hc.put = async (address, file) => {
    got.push(`${address} ${basename(file)}`);
    return `/state/files/${address}/${basename(file)}`;
  };
  assert.deepEqual(await put({ agent: "d/hc:t1", files: [jpeg("a.jpg"), jpeg("a.jpg"), { name: "notes.md", mime: "text/markdown", data: "aGk=" }] }), {
    paths: ["/state/files/t1/a.jpg", "/state/files/t1/a-2.jpg", "/state/files/t1/notes.md"],
  });
  assert.deepEqual(got, ["t1 a.jpg", "t1 a-2.jpg", "t1 notes.md"]);

  await assert.rejects(put({ agent: "d/hc:t1", files: [{ name: "x.png", mime: "image/png", data: "aGk=" }] }), (e: any) => e.code === "bad_request" && /内容和类型对不上/.test(e.message));
  await assert.rejects(put({ agent: "d/hc:t9", files: [jpeg()] }), (e: any) => e.code === "not_found");
  h.hc.put = async () => {
    throw new Error("hc put failed: error: unrecognized subcommand 'put'");
  };
  await assert.rejects(put({ agent: "d/hc:t1", files: [jpeg()] }), (e: any) => e.code === "unsupported" && /hc put/.test(e.message));

  // Agents of the herdr terminal app: this computer keeps the copy.
  h.filesDir = root;
  h.agents = [agent("herdr")];
  const { paths } = await put({ agent: "d/herdr:t1", files: [jpeg("b.jpg")] });
  assert.deepEqual(paths, [join(root, "t1", "b.jpg")]);
  assert.deepEqual(readFileSync(paths[0]!), JPEG);
  h.stop();

  const ro = make(true);
  ro.h.agents = [agent("hc")];
  await assert.rejects(ro.put({ agent: "d/hc:t1", files: [jpeg()] }), (e: any) => e.code === "forbidden");
  ro.h.stop();
});

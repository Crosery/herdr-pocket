import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILES_LIMITS } from "@herdr-pocket/protocol";
import { FilesError, listFiles, looksBinary, readFileSlice, resolveInside } from "../src/files.ts";

let dir: string;
let root: string;
let outside: string;
let settings: string;
const SYMLINKS = process.platform !== "win32";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "hp-files-"));
  root = join(dir, "project");
  outside = join(dir, "outside");
  settings = join(root, "cfg");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(settings, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "README.md"), "# hi\n");
  writeFileSync(join(root, "b10.txt"), "ten");
  writeFileSync(join(root, "b9.txt"), "nine");
  writeFileSync(join(root, ".hidden"), "h");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, ".env.example"), "SECRET=");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "zh.txt"), "你好世界".repeat(10));
  writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3, 4]));
  writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  writeFileSync(join(settings, "hostd.json"), '{"token":"hp_x"}');
  writeFileSync(join(outside, "secret.txt"), "outside");
  if (SYMLINKS) {
    symlinkSync(outside, join(root, "out-link"));
    symlinkSync(join(root, "src"), join(root, "src-link"));
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "escape.txt"));
    symlinkSync(join(dir, "nowhere"), join(root, "dangling"));
  }
});

after(() => rmSync(dir, { recursive: true, force: true }));

const code = (e: unknown) => (e as FilesError).code;

test("lists folders first, by name with numbers in order; hidden and heavy folders only when asked", async () => {
  const r = await listFiles(root, {});
  const names = r.entries.map((e) => e.name);
  assert.deepEqual(names.slice(0, 2), ["cfg", "src"]);
  assert.ok(names.indexOf("b9.txt") < names.indexOf("b10.txt"));
  assert.ok(!names.includes("node_modules") && !names.includes(".git") && !names.includes(".hidden"));
  assert.equal(r.path, "");
  assert.equal(r.truncated, false);
  const readme = r.entries.find((e) => e.name === "README.md")!;
  assert.deepEqual([readme.kind, readme.size, readme.path], ["file", 5, "README.md"]);

  const all = await listFiles(root, { all: true, hidden: true });
  const nm = all.entries.find((e) => e.name === "node_modules")!;
  assert.deepEqual([nm.kind, nm.ignored], ["dir", true]);
  assert.equal(all.entries.find((e) => e.name === ".git")?.ignored, true);
  assert.equal(all.entries.find((e) => e.name === ".hidden")?.hidden, true);
  assert.equal(all.entries.find((e) => e.name === ".env")?.private, true);
  assert.equal(all.entries.find((e) => e.name === ".env.example")?.private, undefined);

  const sub = await listFiles(root, { path: "src" });
  assert.deepEqual(sub.entries.map((e) => e.path).slice(0, 2), ["src/deep", "src/a.ts"]);
  const few = await listFiles(root, { limit: 2 });
  assert.equal(few.entries.length, 2);
  assert.equal(few.truncated, true);
});

test("never leaves the folder: .., absolute paths, private files and the settings folder", async () => {
  await assert.rejects(listFiles(root, { path: "../outside" }), (e) => code(e) === "forbidden");
  await assert.rejects(listFiles(root, { path: "src/../../outside" }), (e) => code(e) === "forbidden");
  await assert.rejects(readFileSlice(root, { path: "/etc/hosts" }), (e) => code(e) === "bad_request");
  await assert.rejects(readFileSlice(root, { path: "C:\\Windows\\win.ini" }), (e) => code(e) === "bad_request");
  await assert.rejects(readFileSlice(root, { path: ".env" }), (e) => code(e) === "forbidden");
  await assert.rejects(readFileSlice(root, { path: "cfg/hostd.json" }, { privateDirs: [settings] }), (e) => code(e) === "forbidden");
  await assert.rejects(listFiles(root, { path: "cfg" }, { privateDirs: [settings] }), (e) => code(e) === "forbidden");
  await assert.rejects(readFileSlice(root, { path: "missing.txt" }), (e) => code(e) === "not_found");
  await assert.rejects(listFiles(undefined, {}), (e) => code(e) === "not_found");
  await assert.rejects(listFiles("relative/dir", {}), (e) => code(e) === "not_found");
  assert.equal((await resolveInside(root, "./src//a.ts")).rel, "src/a.ts");
});

test("symlinks: followed inside, shown as links and refused when they lead out", { skip: !SYMLINKS }, async () => {
  const r = await listFiles(root, {});
  const out = r.entries.find((e) => e.name === "out-link")!;
  const inside = r.entries.find((e) => e.name === "src-link")!;
  const dangling = r.entries.find((e) => e.name === "dangling")!;
  assert.deepEqual([out.kind, out.symlink], ["link", undefined]);
  assert.deepEqual([inside.kind, inside.symlink], ["dir", true]);
  assert.equal(dangling.kind, "link");
  await assert.rejects(listFiles(root, { path: "out-link" }), (e) => code(e) === "forbidden");
  await assert.rejects(readFileSlice(root, { path: "out-link/secret.txt" }), (e) => code(e) === "forbidden");
  await assert.rejects(readFileSlice(root, { path: "src/escape.txt" }), (e) => code(e) === "forbidden");
  assert.equal((await readFileSlice(root, { path: "src-link/a.ts" })).text, "export const a = 1;\n");
});

test("reads text in pieces on character boundaries, flags binaries, sends small pictures", async () => {
  const ts = await readFileSlice(root, { path: "src/a.ts" });
  assert.deepEqual([ts.text, ts.language, ts.binary, ts.truncated, ts.bytes], ["export const a = 1;\n", "ts", false, false, 20]);

  // 40 Chinese characters, 3 bytes each: a 10-byte piece holds 3 of them.
  const first = await readFileSlice(root, { path: "src/zh.txt", maxBytes: 10 });
  assert.deepEqual([first.text, first.bytes, first.truncated, first.offset], ["你好世", 9, true, 0]);
  const second = await readFileSlice(root, { path: "src/zh.txt", maxBytes: 10, offset: first.offset + first.bytes });
  assert.equal(second.text, "界你好");
  // An offset inside a character starts at the next one.
  const mid = await readFileSlice(root, { path: "src/zh.txt", maxBytes: 6, offset: 1 });
  assert.deepEqual([mid.offset, mid.text], [3, "好世"]);
  const tail = await readFileSlice(root, { path: "src/zh.txt", offset: 117 });
  assert.deepEqual([tail.text, tail.truncated], ["界", false]);

  const bin = await readFileSlice(root, { path: "bin.dat" });
  assert.deepEqual([bin.binary, bin.text, bin.base64], [true, undefined, undefined]);
  const png = await readFileSlice(root, { path: "logo.png" });
  assert.deepEqual([png.binary, png.mime, Buffer.from(png.base64!, "base64").length], [true, "image/png", 7]);
  await assert.rejects(readFileSlice(root, { path: "src" }), (e) => code(e) === "bad_request");
  assert.equal(looksBinary(Buffer.from([0xff, 0xfe, 0x41])), true);
  assert.equal(looksBinary(Buffer.from("plain")), false);
  assert.ok(FILES_LIMITS.read < FILES_LIMITS.readMax);
});

test("extraRoots allows trusted absolute paths while still blocking private and outside files", async () => {
  const attachments = join(dir, "herdr-attachments");
  mkdirSync(attachments, { recursive: true });
  writeFileSync(join(attachments, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  writeFileSync(join(attachments, ".env"), "SECRET=1");

  const img = await readFileSlice(root, { path: join(attachments, "shot.png") }, { extraRoots: [attachments], privateDirs: [settings] });
  assert.equal(img.mime, "image/png");
  assert.equal(img.bytes, 6);

  await assert.rejects(
    readFileSlice(root, { path: join(outside, "secret.txt") }, { extraRoots: [attachments], privateDirs: [settings] }),
    (e) => code(e) === "forbidden",
  );
  await assert.rejects(
    readFileSlice(root, { path: join(attachments, ".env") }, { extraRoots: [attachments], privateDirs: [settings] }),
    (e) => code(e) === "forbidden",
  );
  await assert.rejects(
    readFileSlice(root, { path: join(settings, "hostd.json") }, { extraRoots: [attachments], privateDirs: [settings] }),
    (e) => code(e) === "forbidden",
  );
});

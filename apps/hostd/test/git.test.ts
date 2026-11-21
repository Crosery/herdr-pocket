import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listFiles } from "../src/files.ts";
import {
  getGitDiff,
  getGitLog,
  getGitStatus,
  gitCheckout,
  gitCommit,
  gitDiscard,
  gitStage,
  gitUnstage,
} from "../src/git.ts";

const rootTmp = mkdtempSync(join(tmpdir(), "herdr-pocket-git-"));
after(() => rmSync(rootTmp, { recursive: true, force: true }));

function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("git status, numstat, files.list propagation, stage/unstage/diff/commit/checkout/discard", async () => {
  const repo = join(rootTmp, "app");
  mkdirSync(join(repo, "src"), { recursive: true });
  gitSync(repo, "init");
  gitSync(repo, "config", "core.autocrlf", "false");
  gitSync(repo, "config", "user.name", "Tester");
  gitSync(repo, "config", "user.email", "tester@example.com");
  writeFileSync(join(repo, "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  gitSync(repo, "add", ".");
  gitSync(repo, "commit", "-m", "initial commit");

  // Modify tracked file inside src/ and add an untracked file inside src/.
  writeFileSync(join(repo, "src", "index.ts"), "export const a = 2;\nexport const b = 3;\n");
  writeFileSync(join(repo, "src", "extra.txt"), "hello world\nsecond line\n");

  const listed = await listFiles(repo, {});
  const srcDir = listed.entries.find((e) => e.name === "src");
  assert.equal(srcDir?.gitStatus, "M", "parent dir receives highest-priority modified badge");

  const subListed = await listFiles(repo, { path: "src" });
  const idxEntry = subListed.entries.find((e) => e.name === "index.ts");
  const extraEntry = subListed.entries.find((e) => e.name === "extra.txt");
  assert.equal(idxEntry?.gitStatus, "M");
  assert.equal(extraEntry?.gitStatus, "?");

  const st1 = await getGitStatus(repo);
  assert.equal(st1.isRepo, true);
  assert.equal(st1.staged.length, 0);
  assert.equal(st1.unstaged.length, 2);
  const idxChange = st1.unstaged.find((c) => c.path === "src/index.ts");
  assert.equal(idxChange?.additions, 2);
  assert.equal(idxChange?.deletions, 1);

  const untrackedDiff = await getGitDiff(repo, { path: "src/extra.txt", staged: false });
  assert.equal(untrackedDiff.additions, 3);
  assert.equal(untrackedDiff.newText, "hello world\nsecond line\n");

  await gitStage(repo, { paths: ["src/index.ts"] });
  const st2 = await getGitStatus(repo);
  assert.equal(st2.staged.length, 1);
  assert.equal(st2.staged[0]!.path, "src/index.ts");

  const stagedDiff = await getGitDiff(repo, { path: "src/index.ts", staged: true });
  assert.ok(stagedDiff.patch.includes("+export const b = 3;"));
  assert.equal(stagedDiff.oldText, "export const a = 1;\n");
  assert.equal(stagedDiff.newText, "export const a = 2;\nexport const b = 3;\n");

  await gitUnstage(repo, { paths: ["src/index.ts"] });
  const st3 = await getGitStatus(repo);
  assert.equal(st3.staged.length, 0);

  await gitStage(repo, { paths: ["src/index.ts", "src/extra.txt"] });
  const committed = await gitCommit(repo, "feat: update index and add extra");
  assert.ok(committed.hash.length >= 4);
  assert.equal(committed.subject, "feat: update index and add extra");

  const commits = await getGitLog(repo, 10);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]!.subject, "feat: update index and add extra");

  await gitCheckout(repo, { branch: "feat/test-branch", create: true });
  const st4 = await getGitStatus(repo);
  assert.equal(st4.branch, "feat/test-branch");
  assert.ok(st4.branches.includes("feat/test-branch"));

  writeFileSync(join(repo, "README.md"), "dirty edit\n");
  await gitDiscard(repo, { paths: ["README.md"], untracked: false });
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# Demo\n");

  await assert.rejects(gitStage(repo, { paths: ["../outside"] }), /超出|路径/);
});

// Desktop session storage (src/lib/sessionStore.ts): session.json only, legacy localStorage
// copies moved once. Run with `pnpm test` (node --test; Node strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopSessionStore, type DesktopSessionDeps } from "../src/lib/sessionStore.ts";

interface Session {
  server: string;
  token: string;
  deviceId: string;
  deviceName: string;
}

const A: Session = { server: "https://pocket.example.com", token: "test-token-a", deviceId: "d1", deviceName: "desk" };
const B: Session = { ...A, token: "test-token-b" };

function fake(opts: { file?: Session | null; legacy?: string | null; saveFails?: boolean } = {}) {
  const st = {
    file: opts.file ?? null,
    legacy: opts.legacy ?? null,
    saves: 0,
    warns: [] as string[],
    infos: [] as string[],
  };
  const deps: DesktopSessionDeps<Session> = {
    load: async () => st.file,
    save: async (s) => {
      st.saves++;
      if (opts.saveFails) throw new Error("disk full");
      st.file = s;
    },
    clear: async () => {
      st.file = null;
    },
    legacyGet: () => st.legacy,
    legacyRemove: () => {
      st.legacy = null;
    },
    warn: (m) => void st.warns.push(m),
    info: (m) => void st.infos.push(m),
  };
  return { st, deps };
}

test("a 0.2.x localStorage session moves into session.json once and is removed", async () => {
  const { st, deps } = fake({ legacy: JSON.stringify(A) });
  assert.deepEqual(await desktopSessionStore(deps).load(), A);
  assert.deepEqual(st.file, A);
  assert.equal(st.legacy, null);
  assert.equal(st.saves, 1);
  assert.equal(st.infos.length, 1);
  // Next start: read from the file, nothing moved again.
  assert.deepEqual(await desktopSessionStore(deps).load(), A);
  assert.equal(st.saves, 1);
});

test("if the move fails the user stays signed in and the copy stays for the next start", async () => {
  const { st, deps } = fake({ legacy: JSON.stringify(A), saveFails: true });
  const store = desktopSessionStore(deps);
  assert.deepEqual(await store.load(), A);
  assert.equal(st.legacy, JSON.stringify(A));
  assert.equal(st.warns.length, 1);
  assert.deepEqual(await store.load(), A, "kept in memory for this run");
});

test("session.json wins over a leftover copy, which is removed", async () => {
  const { st, deps } = fake({ file: B, legacy: JSON.stringify(A) });
  assert.deepEqual(await desktopSessionStore(deps).load(), B);
  assert.equal(st.legacy, null);
  assert.equal(st.saves, 0);
});

test("saving writes session.json only and drops any localStorage copy", async () => {
  const { st, deps } = fake({ legacy: JSON.stringify(A) });
  await desktopSessionStore(deps).save(B);
  assert.deepEqual(st.file, B);
  assert.equal(st.legacy, null);
});

test("a failed save keeps the session in memory only, never in localStorage", async () => {
  const { st, deps } = fake({ saveFails: true });
  const store = desktopSessionStore(deps);
  await store.save(B);
  assert.equal(st.file, null);
  assert.equal(st.legacy, null);
  assert.equal(st.warns.length, 1);
  assert.deepEqual(await store.load(), B);
  assert.equal(await desktopSessionStore(deps).load(), null, "gone after a restart");
});

test("signing out removes both copies", async () => {
  const { st, deps } = fake({ file: A, legacy: JSON.stringify(A) });
  const store = desktopSessionStore(deps);
  await store.clear();
  assert.equal(st.file, null);
  assert.equal(st.legacy, null);
  assert.equal(await store.load(), null);
});

test("an unusable copy is dropped", async () => {
  for (const legacy of ["not json", JSON.stringify({ server: "https://pocket.example.com" })]) {
    const { st, deps } = fake({ legacy });
    assert.equal(await desktopSessionStore(deps).load(), null);
    assert.equal(st.legacy, null);
    assert.equal(st.saves, 0);
  }
});

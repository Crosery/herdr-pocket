/**
 * Where the desktop (Tauri) app keeps its paired session: session.json in the app's config
 * folder, written by Rust atomically with mode 0600 (load_auth / save_auth / clear_auth).
 * Never the page's localStorage: WebKit and WebView2 keep that in their own store outside
 * session.json, and a copy there would survive deleting session.json (no sign-out).
 *
 * Builds up to 0.2.x wrote a localStorage copy as well. It is moved into session.json once,
 * then removed, so those users stay signed in after the upgrade.
 *
 * No imports: test/sessionStore.test.ts runs this file directly with `node --test`.
 */

export interface SessionLike {
  server: string;
  token: string;
}

export interface DesktopSessionDeps<S extends SessionLike> {
  /** session.json; null when there is none (or it cannot be read). */
  load(): Promise<S | null>;
  save(session: S): Promise<void>;
  clear(): Promise<void>;
  /** The legacy localStorage copy, raw JSON, or null. */
  legacyGet(): string | null;
  legacyRemove(): void;
  /** Log lines (never given the token). */
  warn(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
}

export interface DesktopSessionStore<S extends SessionLike> {
  load(): Promise<S | null>;
  save(session: S): Promise<void>;
  clear(): Promise<void>;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function desktopSessionStore<S extends SessionLike>(deps: DesktopSessionDeps<S>): DesktopSessionStore<S> {
  // A session save_auth could not write (or a legacy one it could not move): this run only.
  let memory: S | null = null;
  const valid = (s: S | null | undefined): s is S => Boolean(s && s.server && s.token);
  const dropLegacy = () => {
    try {
      deps.legacyRemove();
    } catch {
      // nothing to remove, or storage unavailable
    }
  };

  return {
    async load() {
      if (memory) return memory;
      try {
        const s = await deps.load();
        if (valid(s)) {
          // An older build may also have left a copy in localStorage.
          dropLegacy();
          return s;
        }
      } catch (e) {
        deps.warn("session file unreadable", { error: errorText(e) });
      }
      let legacy: S | null = null;
      try {
        const raw = deps.legacyGet();
        legacy = raw ? (JSON.parse(raw) as S) : null;
      } catch {
        legacy = null;
      }
      if (!valid(legacy)) {
        dropLegacy();
        return null;
      }
      try {
        await deps.save(legacy);
        dropLegacy();
        deps.info("session moved from page storage to the session file");
      } catch (e) {
        // Still signed in for this run; the copy stays so the next start can try again.
        memory = legacy;
        deps.warn("session not moved to the session file", { error: errorText(e) });
      }
      return legacy;
    },

    async save(session) {
      try {
        await deps.save(session);
        memory = null;
      } catch (e) {
        memory = session;
        deps.warn("session not saved; kept for this run only", { error: errorText(e) });
      }
      // A new session supersedes any older copy in localStorage.
      dropLegacy();
    },

    async clear() {
      memory = null;
      try {
        await deps.clear();
      } catch (e) {
        deps.warn("session file not removed", { error: errorText(e) });
      }
      dropLegacy();
    },
  };
}

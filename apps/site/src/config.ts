// The one place to change project-specific values on the site.
// Everything that names the repository or a shell command reads from here,
// so forks only edit this file.

const repo = "Crosery/herdr-pocket";
const raw = `https://raw.githubusercontent.com/${repo}/main`;

export const SITE = {
  name: "Herdr Pocket",
  repo,
  latestVersion: "0.2.59",
  githubUrl: `https://github.com/${repo}`,
  releasesUrl: `https://github.com/${repo}/releases`,
  docsUrl: `https://github.com/${repo}#readme`,
  issuesUrl: `https://github.com/${repo}/issues`,
  licenseUrl: `https://github.com/${repo}/blob/main/LICENSE`,
  /** Relative to the page, so the site works under any base path. */
  video: {
    /** HLS, 720p and 1080p in 4-second segments; written by video/scripts/render.sh. */
    hls: "video/hls/master.m3u8",
    poster: "video/intro-poster.webp",
  },
  /** Shown in commands until the visitor types a server address in the deploy section. */
  serverPlaceholder: { zh: "<你的服务器地址>", en: "<your-server>" },
  /** Where the address typed in the deploy section is remembered. */
  serverStorageKey: "hp-server",
  /**
   * Install commands. {host} and {url} come from the deploy section's server field:
   * typing pocket.example.com gives {host} = pocket.example.com and {url} = https://pocket.example.com.
   * install-relay.sh --domain takes a host name; install-host.sh --server and
   * install-host.ps1 -Server take the relay's URL (https:// unless another scheme is typed).
   */
  commands: {
    serverCompose: `mkdir herdr-pocket && cd herdr-pocket\ncurl -fsSLO ${raw}/deploy/docker/compose.yml\ndocker compose up -d\ndocker compose logs relay | grep "setup code"`,
    serverScript: `curl -fsSL ${raw}/scripts/install-relay.sh | sudo bash -s -- --domain {host}`,
    serverCloudflare: `curl -fsSL ${raw}/scripts/install-relay.sh | sudo bash -s -- --tunnel <TUNNEL_TOKEN> --domain {host}`,
    computerInstall: `curl -fsSL ${raw}/scripts/install-host.sh | bash -s -- --server {url}`,
    computerInstallWindows: `& ([scriptblock]::Create((irm ${raw}/scripts/install-host.ps1))) -Server {url}`,
    computerPair: "herdr-pocket pair",
    cliAgents: "herdr-pocket agents",
    cliRead: "herdr-pocket read  macbook/t42",
    cliSend: "herdr-pocket send  macbook/t42 run the tests",
    cliKeys: "herdr-pocket keys  macbook/t42 esc",
  },
} as const;

export type Lang = "zh" | "en";
export type CommandKey = keyof typeof SITE.commands;

/** A relay address as the installers want it. */
export interface Server {
  /** Host name only, for install-relay.sh --domain. */
  host: string;
  /** Scheme, host and port, for install-host --server / -Server and the /admin link. */
  url: string;
}

/** Docs-only addresses: the installers refuse them, so the site does too. */
const EXAMPLE_HOST = /(^|\.)example\.(com|org|net)$/i;

/**
 * Read what a visitor typed ("pocket.your-domain.test", "https://pocket.your-domain.test/admin", "http://192.0.2.10:7420").
 * Returns null for an empty field and "invalid" for something that is not an address.
 */
export function parseServer(input: string): Server | null | "invalid" | "example" {
  const text = input.trim();
  if (!text) return null;
  const scheme = /^(https?):\/\//i.exec(text)?.[1].toLowerCase() ?? "https";
  const rest = text.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").split(/[/?#]/)[0];
  if (!rest || /\s|@/.test(rest)) return "invalid";
  let u: URL;
  try {
    u = new URL(`${scheme}://${rest}`);
  } catch {
    return "invalid";
  }
  const host = u.hostname.replace(/\.$/, "");
  if (!/^(\[[\da-f:.]+\]|[a-z\d-]+(\.[a-z\d-]+)*)$/i.test(host)) return "invalid";
  if (EXAMPLE_HOST.test(host)) return "example";
  return { host, url: `${scheme}://${host}${u.port ? `:${u.port}` : ""}` };
}

/** Does this command need the server address? */
export const needsServer = (cmd: string): boolean => /\{(host|url)\}/.test(cmd);

/** A command with the server filled in, or with an obvious placeholder until there is one. */
export function fillCommand(cmd: string, server: Server | null, lang: Lang): string {
  const ph = SITE.serverPlaceholder[lang];
  return cmd.replaceAll("{host}", server?.host ?? ph).replaceAll("{url}", server?.url ?? `https://${ph}`);
}

/** The prompt shown before a command. */
export const commandPrompt = (key: CommandKey): string => (key === "computerInstallWindows" ? "PS>" : "$");

/**
 * A command as shown on the page. A long line breaks after its pipe (bash carries on after a
 * trailing |) or before PowerShell's -Server (a trailing backtick carries on), so the server
 * address starts its own line and a selected-and-pasted copy still runs. Copy buttons copy the
 * command exactly as written in SITE.commands.
 */
export function commandLines(cmd: string): string[] {
  return cmd.split("\n").flatMap((line) => {
    if (line.length < 64) return [line];
    const ps = / (-Server .*)$/.exec(line);
    if (ps) return [`${line.slice(0, ps.index)} \``, `  ${ps[1]}`];
    const pipe = line.indexOf(" | ");
    return pipe > 0 ? [`${line.slice(0, pipe)} |`, `  ${line.slice(pipe + 3)}`] : [line];
  });
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The inside of a command card: a prompt that selecting leaves out, then the lines, placeholders marked. */
export function commandHtml(cmd: string, prompt: string): string {
  return commandLines(cmd)
    .map((line) => {
      const body = escHtml(line).replace(/&lt;[^\s&]+&gt;/g, (m) => `<mark class="cmd-ph">${m}</mark>`);
      return line.startsWith("  ") ? body : `<span class="cmd-prompt" aria-hidden="true">${escHtml(prompt)} </span>${body}`;
    })
    .join("\n");
}

/** Direct GitHub Release asset download URL for a pinned version + suffix (e.g. "-macos-arm64.dmg"). */
export function releaseAssetUrl(suffix: string, version: string = SITE.latestVersion): string {
  const clean = version.trim().replace(/^v/i, "") || SITE.latestVersion;
  return `https://github.com/${SITE.repo}/releases/download/v${clean}/herdr-pocket-${clean}${suffix}`;
}

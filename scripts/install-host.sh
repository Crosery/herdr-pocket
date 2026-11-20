#!/usr/bin/env bash
# Herdr Pocket for a computer (macOS or Linux): installs the `herdr-pocket` command, registers this
# computer with your relay and keeps it online in the background (launchd, or systemd --user).
# Runs as your user; no sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.sh | bash -s -- --server https://pocket.example.com
#
#   --server <url>      your relay. A phone that is already connected scans the QR code shown and approves.
#   --code <CODE>       register with an invite or setup code instead (first computer on a new relay)
#   <invite link>       the same as one link: https://<server>/p/<CODE> or herdrpocket://pair?...
#   --name <name>       device name (default: this computer's name)
#   --read-only         phones and other computers may look but not type
#   --version <x.y.z>   a given release instead of the latest
#   --dir <path>        install folder (default ~/.local/share/herdr-pocket)
#   --source <path>     install from a local checkout or release bundle instead of GitHub
#   --with-node         use a private Node in <dir>/node even if one is installed
#   --no-service        install the command only; then run `herdr-pocket up` yourself
#
# In mainland China (by the time zone) GitHub and nodejs.org are slow or out of reach, so
# downloads go through mirrors first: ghfast.top / gh-proxy.com for the release, npmmirror.com
# for Node. Checksums still decide. HERDR_POCKET_MIRROR=1 turns that on anywhere (a server
# on UTC), =0 turns it off; so does "update": {"region": "cn"|"global"} in an existing
# config.json (docs/config.md). Release sources are raced first and the fastest is used.
# From China, the script itself also comes through a mirror:
#   curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.sh | bash -s -- ...
#
# Later: `herdr-pocket update` installs new releases, `herdr-pocket status` shows the state.
set -euo pipefail
# Also stop on errors inside $(...) where bash supports it (4.4+).
shopt -s inherit_errexit 2>/dev/null || true

REPO="${HERDR_POCKET_REPO:-Crosery/herdr-pocket}"
NODE_MAJOR=24
LABEL=com.herdr-pocket.hostd
UNIT=herdr-pocket-hostd.service

say() { printf '\033[1;35m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
fetch() { curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"; }
sha256() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

latest_tag() {
  local url
  url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)
  case "$url" in */releases/tag/*) echo "${url##*/}" ;; *) echo "" ;; esac
}

# Mainland China by the time zone (TZ, /etc/localtime, /etc/timezone); HERDR_POCKET_MIRROR forces
# it, then `update.region` in config.json (the same order as `herdr-pocket`, docs/config.md).
in_china() {
  REGION_WHY="HERDR_POCKET_MIRROR"
  case "${HERDR_POCKET_MIRROR:-}" in 1 | true | on | yes | cn) return 0 ;; 0 | false | off | no | global) return 1 ;; esac
  local cfg="${HERDR_POCKET_HOME:-$HOME/.config/herdr-pocket}/config.json" region=""
  [ -f "$cfg" ] && region=$(tr -d '\n' <"$cfg" | sed -n 's/.*"region"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')
  REGION_WHY="config.json update.region"
  case "$region" in cn) return 0 ;; global) return 1 ;; esac
  local tz=${TZ:-}
  [ -n "$tz" ] || tz=$(readlink /etc/localtime 2>/dev/null || true)
  [ -n "$tz" ] || tz=$(cat /etc/timezone 2>/dev/null || true)
  tz=${tz#*zoneinfo/}
  REGION_WHY="time zone ${tz:-unknown}"
  case "$tz" in *Asia/Shanghai | *Asia/Chongqing | *Asia/Chungking | *Asia/Harbin | *Asia/Urumqi | *Asia/Kashgar | *PRC) return 0 ;; esac
  return 1
}
CHINA=0 REGION=global
in_china && CHINA=1 REGION=cn
say "download region: $REGION ($REGION_WHY)"

# Release sources as prefixes put in front of a github.com address ("direct" is GitHub itself):
# the mirrors first in China, last elsewhere (protocol `sourcePrefixes`).
MIRRORS="https://ghfast.top/ https://gh-proxy.com/ https://cdn.gh-proxy.com/ https://edgeone.gh-proxy.com/"
if [ "$CHINA" = 1 ]; then PREFIXES="$MIRRORS direct"; else PREFIXES="direct $MIRRORS"; fi

# Asks every source at once for the latest release's small SHA256SUMS (4 s each) and puts the
# fastest first; one earlier in the order wins when it was at most 0.15 s slower (protocol `pickFastest`).
race_sources() {
  local dir i=0 p best="" best_t="" t
  dir=$(mktemp -d)
  for p in $PREFIXES; do
    i=$((i + 1))
    (
      u="https://github.com/$REPO/releases/latest/download/SHA256SUMS"
      [ "$p" = direct ] || u="$p$u"
      t=$(curl -fsSL --max-time 4 -o "$dir/$i" -w '%{time_total}' "$u" 2>/dev/null) && grep -q 'herdr-pocket-' "$dir/$i" && echo "$t" >"$dir/$i.t"
    ) &
  done
  wait
  i=0
  for p in $PREFIXES; do
    i=$((i + 1))
    [ -s "$dir/$i.t" ] || continue
    t=$(cat "$dir/$i.t")
    if [ -z "$best" ] || awk -v a="$t" -v b="$best_t" 'BEGIN { exit !(a + 0.15 < b) }'; then
      best=$p
      best_t=$t
    fi
  done
  rm -rf "$dir"
  [ -n "$best" ] || return 0
  say "fastest download source: $([ "$best" = direct ] && echo github.com || echo "${best#https://}") (${best_t}s)"
  PREFIXES="$best $(for p in $PREFIXES; do [ "$p" = "$best" ] || printf '%s ' "$p"; done)"
}

# A github.com file from the first source that delivers, in PREFIXES order.
# A source slower than 20 KB/s for 20 s gives way to the next.
gh_fetch() {
  local p u
  for p in $PREFIXES; do
    u=$1
    [ "$p" = direct ] || u="$p$1"
    curl -fsSL --retry 2 --connect-timeout 15 --speed-limit 20000 --speed-time 20 -o "$2" "$u" && return 0
  done
  return 1
}

node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null
}

private_node() {
  local dir=$1 os arch base tmp file want
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "no Node build for $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) die "no Node build for $(uname -m)" ;; esac
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp=$(mktemp -d)
  # The checksums from nodejs.org itself; npmmirror's latest-v* list can lag behind.
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || {
    [ "$CHINA" = 1 ] && fetch "https://npmmirror.com/mirrors/node/latest-v$NODE_MAJOR.x/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  } || die "could not reach nodejs.org"
  file=$(grep -o "node-v[0-9.]*-$os-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n 1)
  [ -n "$file" ] || die "nodejs.org lists no $os-$arch build"
  say "downloading $file"
  local ver=${file#node-} mirror
  ver=${ver%%-*}
  mirror="https://npmmirror.com/mirrors/node/$ver/$file"
  if [ "$CHINA" = 1 ]; then
    fetch "$mirror" "$tmp/$file" || fetch "$base/$file" "$tmp/$file"
  else
    fetch "$base/$file" "$tmp/$file" || fetch "$mirror" "$tmp/$file"
  fi || die "downloading $file failed; run the installer again"
  want=$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")
  [ "$(sha256 "$tmp/$file")" = "$want" ] || die "checksum mismatch for $file"
  rm -rf "$dir.new" && mkdir -p "$dir.new"
  tar -xzf "$tmp/$file" -C "$dir.new" --strip-components=1 --no-same-owner
  rm -rf "$dir" && mv "$dir.new" "$dir" && rm -rf "$tmp"
  echo "$dir/bin/node"
}

find_node() {
  local n
  if [ "$WITH_NODE" != 1 ]; then
    for n in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
      [ -n "$n" ] && [ -x "$n" ] && node_ok "$n" && { echo "$n"; return; }
    done
  fi
  [ -x "$DIR/node/bin/node" ] && node_ok "$DIR/node/bin/node" && { echo "$DIR/node/bin/node"; return; }
  say "no Node >= 22.18 found: installing Node $NODE_MAJOR into $DIR/node"
  private_node "$DIR/node"
}

# Unpack the release bundle into $DIR/releases/<version> and point $DIR/current at it.
install_bundle() {
  local tmp file tag ver want
  tmp=$(mktemp -d)
  if [ -n "$SOURCE" ] && [ -d "$SOURCE" ]; then
    say "packing $SOURCE"
    file=$("$SOURCE/scripts/pack-release.sh" "$tmp")
  elif [ -n "$SOURCE" ]; then
    file=$SOURCE
  else
    race_sources
    if [ -n "$VERSION" ]; then
      tag="v${VERSION#v}"
      gh_fetch "https://github.com/$REPO/releases/download/$tag/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null || rm -f "$tmp/SHA256SUMS"
    elif gh_fetch "https://github.com/$REPO/releases/latest/download/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
      # The newest release is the one its checksum list names (mirrors carry this file, not the API).
      tag=v$(sed -n 's/^[0-9a-fA-F]\{64\}[ *]*herdr-pocket-\([^ ]*\)\.tar\.gz$/\1/p' "$tmp/SHA256SUMS" | head -n 1)
      [ "$tag" != v ] || tag=""
    else
      rm -f "$tmp/SHA256SUMS"
      tag=$(latest_tag)
    fi
    [ -n "$tag" ] || die "$REPO has no release yet, or GitHub$([ "$CHINA" = 1 ] && echo " and its mirrors are" || echo " is") out of reach: use --source <checkout or bundle>"
    ver=${tag#v}
    say "downloading Herdr Pocket $ver"
    file="$tmp/herdr-pocket-$ver.tar.gz"
    gh_fetch "https://github.com/$REPO/releases/download/$tag/herdr-pocket-$ver.tar.gz" "$file" || die "downloading herdr-pocket-$ver.tar.gz failed; run the installer again"
    if [ -s "$tmp/SHA256SUMS" ]; then
      want=$(awk -v f="herdr-pocket-$ver.tar.gz" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
      [ "$(sha256 "$file")" = "$want" ] || die "checksum mismatch for herdr-pocket-$ver.tar.gz"
    fi
  fi
  mkdir -p "$tmp/x"
  tar -xzf "$file" -C "$tmp/x" --strip-components=1 --no-same-owner
  ver=$("$NODE" -p "require('$tmp/x/package.json').version")
  mkdir -p "$DIR/releases"
  if [ "$(readlink "$DIR/current" 2>/dev/null || true)" = "releases/$ver" ]; then
    say "Herdr Pocket $ver is already installed"
  else
    rm -rf "$DIR/releases/$ver"
    mv "$tmp/x" "$DIR/releases/$ver"
    if [ -L "$DIR/current" ]; then ln -sfn "$(readlink "$DIR/current")" "$DIR/previous"; fi
    ln -sfn "releases/$ver" "$DIR/current"
  fi
  rm -rf "$tmp"
  INSTALLED=$ver
}

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
daemon_running() { "$CMD" status 2>/dev/null | grep -q "^daemon *running"; }

# Load the launchd agent from $1, replacing the one already loaded. `launchctl bootout`
# returns before the old process has exited, and `bootstrap` fails with "5: Input/output
# error" while it is still there; it fails the same way for a service disabled earlier
# (launchctl unload -w). So: enable, bootout, wait until it is gone, bootstrap, and go round
# again if the old one was slow to stop. Over SSH with nobody logged in at the screen there
# is no gui/<uid> domain; user/<uid> runs it then.
launchd_load() {
  local plist=$1 uid domain target err="" try waited
  uid=$(id -u)
  domain="gui/$uid"
  launchctl print "$domain" >/dev/null 2>&1 || domain="user/$uid"
  target="$domain/$LABEL"
  plutil -lint -s "$plist" || die "$plist is not a valid property list"
  launchctl enable "$target" >/dev/null 2>&1 || true
  for try in 1 2 3 4 5; do
    launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
    launchctl bootout "user/$uid/$LABEL" >/dev/null 2>&1 || true
    waited=0
    while launchctl print "$target" >/dev/null 2>&1 && [ "$waited" -lt 30 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    err=$(launchctl bootstrap "$domain" "$plist" 2>&1) && return 0
    [ "$try" = 1 ] && say "waiting for the previous Herdr Pocket to stop"
    sleep 2
  done
  die "launchd would not start Herdr Pocket: ${err%%$'\n'*}
  Run the same command again in a minute. If it fails the same way, send this output and:
    launchctl print $target"
}

# ----------------------------------------------------------------------------------------------------------------------------------

SERVER="" CODE="" LINK="" NAME="" READ_ONLY=0 VERSION="" SOURCE="" WITH_NODE=0 NO_SERVICE=0 INSTALLED=""
DIR="$HOME/.local/share/herdr-pocket"
BIN_DIR="$HOME/.local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER=${2:?}; shift 2 ;;
    --code) CODE=${2:?}; shift 2 ;;
    --name) NAME=${2:?}; shift 2 ;;
    --read-only) READ_ONLY=1; shift ;;
    --version) VERSION=${2:?}; shift 2 ;;
    --dir) DIR=${2:?}; shift 2 ;;
    --source) SOURCE=$(cd "$(dirname "${2:?}")" && pwd)/$(basename "$2"); shift 2 ;;
    --with-node) WITH_NODE=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    -h | --help) [ -f "$0" ] && sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) LINK=$1; shift ;;
  esac
done

# The example from the docs, pasted as it is: say so before downloading anything.
for given in "$SERVER" "$LINK"; do
  host=${given#*://}
  host=${host%%[/:?]*}
  case "$host" in
    example.com | example.org | example.net | *.example.com | *.example.org | *.example.net)
      die "$given is the example address from the docs, not a real relay.
  Put your own relay's address after --server (the address your phone connects to).
  No relay yet? Set one up first: https://github.com/$REPO#1-deploy-the-relay" ;;
  esac
done

case "$(uname -s)" in Darwin) OS=macos ;; Linux) OS=linux ;; *) die "Herdr Pocket runs on macOS and Linux" ;; esac
[ "$(id -u)" != 0 ] || warn "running as root: the computer is registered for root, not for your user"
have curl || die "curl is needed"
mkdir -p "$DIR" "$BIN_DIR"
DIR=$(cd "$DIR" && pwd -P)

NODE=$(find_node)
install_bundle
say "Herdr Pocket $INSTALLED is in $DIR (Node: $NODE)"

# The command: a small script with fixed paths, so it works without Node on PATH.
CMD="$BIN_DIR/herdr-pocket"
if [ -e "$CMD" ] && ! grep -q "install-host.sh" "$CMD" 2>/dev/null; then
  mv "$CMD" "$CMD.bak"
  warn "moved the previous $CMD to $CMD.bak"
fi
cat >"$CMD" <<EOF
#!/bin/sh
# Written by install-host.sh. Update with: herdr-pocket update
exec "$NODE" --no-warnings "$DIR/current/apps/hostd/src/cli.ts" "\$@"
EOF
chmod 755 "$CMD"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on your PATH: add  export PATH=\"$BIN_DIR:\$PATH\"  to your shell profile" ;; esac

# The agents come from herdr: without it this computer comes online with none.
missing=""
for tool in herdr hc; do have "$tool" || [ -x "$BIN_DIR/$tool" ] || missing="$missing $tool"; done
[ -z "$missing" ] || warn "not installed yet:$missing. Install herdr (it provides hc) first, then your agents show up"
have uniflo || warn "optional: Uniflo is not installed; install and start it to see full conversation history"

# Register unless this computer already is (with the same relay).
config="${HERDR_POCKET_HOME:-$HOME/.config/herdr-pocket}/hostd.json"
registered=0
if [ -f "$config" ] && [ -z "$LINK$CODE" ]; then
  current_server=$("$NODE" -p "try{require('$config').server||''}catch{''}")
  wanted=${SERVER%/}
  case "$wanted" in "" | http://* | https://*) ;; *) wanted="https://$wanted" ;; esac
  if [ -n "$current_server" ] && { [ -z "$wanted" ] || [ "$wanted" = "$current_server" ]; }; then
    registered=1
    say "already registered with $current_server"
  fi
fi
if [ "$registered" = 0 ]; then
  if [ -n "$SERVER$LINK$CODE" ]; then
    args=()
    [ -n "$LINK" ] && args+=("$LINK")
    [ -n "$SERVER" ] && args+=(--server "$SERVER")
    [ -n "$CODE" ] && args+=(--code "$CODE")
    [ -n "$NAME" ] && args+=(--name "$NAME")
    # Under `curl | bash` stdin is the script; give the login the terminal when there is one.
    if (: </dev/tty) 2>/dev/null; then "$CMD" login "${args[@]}" </dev/tty; else "$CMD" login "${args[@]}"; fi
    registered=1
  else
    warn "no --server given: the command is installed, this computer is not registered yet"
  fi
fi

run_args=(run)
[ "$READ_ONLY" = 1 ] && run_args+=(--read-only)

if [ "$NO_SERVICE" = 1 ] || [ "$registered" = 0 ]; then
  cat >&2 <<EOF

Next
  herdr-pocket up${SERVER:+ --server $SERVER}     register (if needed) and keep this computer online
  herdr-pocket update                  install new releases
EOF
  exit 0
fi

if [ "$OS" = macos ]; then
  # A daemon started by hand would make the service exit with "already running".
  if daemon_running && ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    warn "herdr-pocket is already running in a terminal: stop it (Ctrl+C) so the background service can take over"
  fi
  plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  log_dir="$HOME/Library/Logs/herdr-pocket"
  mkdir -p "$(dirname "$plist")" "$log_dir"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by install-host.sh: keeps Herdr Pocket online. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>--no-warnings</string>
    <string>$(xml "$DIR")/current/apps/hostd/src/cli.ts</string>
EOF
    for a in "${run_args[@]}"; do printf '    <string>%s</string>\n' "$a"; done
    cat <<EOF
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml "$(dirname "$NODE"):$PATH")</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$log_dir")/hostd.log</string>
  <key>StandardErrorPath</key><string>$(xml "$log_dir")/hostd.log</string>
</dict>
</plist>
EOF
  } >"$plist"
  launchd_load "$plist"
  logs="$log_dir/hostd.log"
else
  if daemon_running && ! systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
    warn "herdr-pocket is already running in a terminal: stop it (Ctrl+C) so the background service can take over"
  fi
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  cat >"$unit_dir/$UNIT" <<EOF
# Written by install-host.sh: keeps Herdr Pocket online.
[Unit]
Description=Herdr Pocket host
After=network-online.target

[Service]
ExecStart=$NODE --no-warnings $DIR/current/apps/hostd/src/cli.ts ${run_args[*]}
Environment="PATH=$(dirname "$NODE"):$PATH"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1
  systemctl --user restart "$UNIT"
  # Keep it running after you log out.
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || warn "to keep it online after logout: sudo loginctl enable-linger $(id -un)"
  logs="journalctl --user -u $UNIT -f"
fi

for _ in $(seq 1 10); do
  daemon_running && break
  sleep 1
done
echo >&2
"$CMD" status || true
cat >&2 <<EOF

Herdr Pocket runs in the background and starts with your session.
  Logs     $logs
  Update   herdr-pocket update
  Invite   herdr-pocket pair     (QR code for a phone or another computer)
EOF

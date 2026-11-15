#!/usr/bin/env bash
# Build the relay + host bundle a release ships, herdr-pocket-<version>.tar.gz: the runtime
# sources with production node_modules, so installs and `update` need neither git nor pnpm.
# The dependencies are plain JavaScript, so one bundle serves macOS and Linux on any CPU.
#
# Usage: scripts/pack-release.sh [out-dir]     (default dist/; version from package.json,
#                                              stamp it first with scripts/set-version.mjs)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$root/package.json').version")
out="${1:-$root/dist}"
mkdir -p "$out"
out=$(cd "$out" && pwd)
name="herdr-pocket-$version"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
stage="$tmp/$name"
mkdir -p "$stage"

# Copy a folder without tests, local state or installed deps.
copy() {
  mkdir -p "$stage/$1"
  (cd "$root/$1" && COPYFILE_DISABLE=1 tar -cf - --exclude=node_modules --exclude=test --exclude=data \
    --exclude='*.db' --exclude='*.db-*' --exclude='*.db.key' --exclude='.env' --exclude='.DS_Store' .) | (cd "$stage/$1" && tar -xf -)
}

for f in package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE README.md; do
  [ -e "$root/$f" ] && cp "$root/$f" "$stage/"
done
for d in "$root"/packages/*/; do copy "packages/$(basename "$d")"; done
copy apps/relay
copy apps/hostd
copy deploy
copy scripts
# Readable by the service user whatever the working copy's modes are.
chmod -R u+rwX,go+rX,go-w "$stage"

(cd "$stage" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.confirmModulesPurge=false \
  --filter "@herdr-pocket/relay..." --filter "@herdr-pocket/hostd..." >/dev/null)

# Both CLIs must start from the staged copy before it is packed.
[ "$(node --no-warnings "$stage/apps/hostd/src/cli.ts" --version)" = "$version" ]
[ "$(node --no-warnings "$stage/apps/relay/src/cli.ts" selftest)" = "$version" ]

file="$out/$name.tar.gz"
if tar --version 2>/dev/null | grep -q GNU; then
  tar -czf "$file" -C "$tmp" --owner=0 --group=0 --numeric-owner --sort=name "$name"
else
  COPYFILE_DISABLE=1 tar -czf "$file" -C "$tmp" --uid 0 --gid 0 --numeric-owner "$name"
fi
echo "$file"

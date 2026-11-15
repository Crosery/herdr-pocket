#!/bin/sh
# Render the intro film, its poster frame and the social card into ../public.
#
# Frames are taken with Remotion's Chrome Headless Shell (downloaded once by
# `remotion browser ensure`). A full Google Chrome sometimes took a screenshot before
# it had finished drawing, a tiled or half-drawn frame that flashed in the film;
# scripts/check-frames.mjs stops the script if such a frame gets through.
# REMOTION_BROWSER=<path> renders with another browser anyway.
#
# The film is published as HLS (../public/video/hls/master.m3u8): 4-second fMP4
# segments in 720p and 1080p, so the page fetches only what is about to play and
# the player picks the size itself.
set -eu
cd "$(dirname "$0")/.."
if [ -n "${REMOTION_BROWSER:-}" ]; then
  set -- "--browser-executable=$REMOTION_BROWSER"
else
  set --
  npx remotion browser ensure >/dev/null
fi
mkdir -p out ../public/video
# A near-lossless master; the HLS encode below sets the published sizes.
npx remotion render src/index.ts Intro out/intro.mp4 "$@" --codec=h264 --crf=16 --pixel-format=yuv420p --concurrency="${CONCURRENCY:-4}" --log=error
ffmpeg -v error -i out/intro.mp4 -vf scale=192:108,format=gray -f rawvideo - | node scripts/check-frames.mjs
npx remotion still src/index.ts Intro out/poster.png --frame="${POSTER_FRAME:-540}" "$@" --log=error
npx remotion still src/index.ts Og out/og.png "$@" --log=error

# 720p first (where players start), then 1080p. A keyframe every 4 s in both, so every
# segment starts clean and a player can switch sizes between any two of them.
hls=../public/video/hls
rm -rf "$hls"
mkdir -p "$hls"
ffmpeg -v error -y -i out/intro.mp4 \
  -filter_complex "[0:v]split=2[hd][x];[x]scale=1280:720:flags=lanczos[sd]" \
  -map "[sd]" -map "[hd]" \
  -c:v libx264 -preset slow -profile:v high -pix_fmt yuv420p \
  -crf:v:0 25 -maxrate:v:0 1500k -bufsize:v:0 3000k \
  -crf:v:1 23 -maxrate:v:1 3500k -bufsize:v:1 7000k \
  -force_key_frames "expr:gte(t,n_forced*4)" -sc_threshold 0 \
  -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_flags independent_segments \
  -hls_segment_filename "$hls/%v/%03d.m4s" -hls_fmp4_init_filename init.mp4 \
  -master_pl_name master.m3u8 -var_stream_map "v:0,name:720p v:1,name:1080p" \
  "$hls/%v/index.m3u8"

cwebp -quiet -q 82 -resize 1280 0 out/poster.png -o ../public/video/intro-poster.webp
magick out/og.png -strip -quality 86 ../public/og.jpg
du -sh "$hls" ../public/video/intro-poster.webp ../public/og.jpg

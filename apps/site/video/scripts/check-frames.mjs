// Fails when the film has a flash: one frame far from both neighbours while the
// neighbours agree with each other (a half-drawn or tiled screenshot).
//   ffmpeg -v error -i out/intro.mp4 -vf scale=192:108,format=gray -f rawvideo - | node scripts/check-frames.mjs
// Prints the frame numbers; re-render them, or the whole film, with the headless shell.
const W = 192;
const H = 108;
const N = W * H;
const LIMIT = Number(process.env.FLASH_LIMIT ?? 1.5);

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const buf = Buffer.concat(chunks);
const n = Math.floor(buf.length / N);
const diff = (a, b) => {
  let s = 0;
  for (let k = 0; k < N; k++) s += Math.abs(buf[a * N + k] - buf[b * N + k]);
  return s / N;
};

const flashes = [];
for (let i = 1; i < n - 1; i++) {
  const score = Math.min(diff(i - 1, i), diff(i, i + 1)) - diff(i - 1, i + 1);
  if (score > LIMIT) flashes.push(`${i} (${score.toFixed(1)})`);
}
if (n === 0) {
  console.error("check-frames: no frames on stdin");
  process.exit(1);
}
if (flashes.length) {
  console.error(`check-frames: ${flashes.length} flashing frame(s) of ${n}: ${flashes.join(", ")}`);
  process.exit(1);
}
console.log(`check-frames: ${n} frames, no flashes`);

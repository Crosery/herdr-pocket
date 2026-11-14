// Composes docs/screenshots/*.webp into one fanned row of phones per theme:
// docs/readme/showcase-light.webp and showcase-dark.webp (transparent, so they
// sit on GitHub's light and dark page). Needs magick and cwebp on PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.resolve(HERE, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hp-showcase-"));
const W = 1440;
const H = 780;
const magick = (...args) => execFileSync("magick", args, { stdio: ["ignore", "ignore", "inherit"] });

// Left to right; the middle phone is in front. x/top place the unscaled 300x645 phone.
const SCREENS = ["agents", "chat", "assistant", "terminal", "call"];
const SLOTS = [
  { x: 270, top: 150, scale: 0.8, rot: -11, z: 1 },
  { x: 490, top: 92, scale: 0.9, rot: -5.5, z: 2 },
  { x: 720, top: 48, scale: 1, rot: 0, z: 3 },
  { x: 950, top: 92, scale: 0.9, rot: 5.5, z: 2 },
  { x: 1170, top: 150, scale: 0.8, rot: 11, z: 1 },
];
const THEME = {
  light: { frame: "#2A2231", shadow: "#A03C78", opacity: 42, glow: "#F27BA6", glowAlpha: "40" },
  dark: { frame: "#0F0C14", shadow: "#000000", opacity: 70, glow: "#FF8FB8", glowAlpha: "30" },
};
const off = (n) => (n >= 0 ? `+${Math.round(n)}` : `${Math.round(n)}`);

for (const theme of ["light", "dark"]) {
  const t = THEME[theme];
  const mask = path.join(TMP, "mask.png");
  magick("-size", "282x627", "xc:none", "-fill", "white", "-draw", "roundrectangle 0,0 281,626 37,37", mask);
  const phones = SCREENS.map((s, i) => {
    const p = SLOTS[i];
    const screen = path.join(TMP, `${theme}-${s}-screen.png`);
    const phone = path.join(TMP, `${theme}-${s}-phone.png`);
    magick(path.join(ROOT, `docs/screenshots/${theme}-${s}.webp`), "-resize", "282x627!", mask, "-alpha", "set", "-compose", "DstIn", "-composite", screen);
    magick(
      "-size", "300x645", "xc:none", "-fill", t.frame, "-draw", "roundrectangle 0,0 299,644 46,46",
      screen, "-geometry", "+9+9", "-compose", "Over", "-composite",
      "-resize", `${p.scale * 100}%`, "-background", "none", "-rotate", String(p.rot),
      "(", "+clone", "-background", t.shadow, "-shadow", `${t.opacity}x16+0+20`, ")",
      "+swap", "-background", "none", "-layers", "merge", "+repage", phone,
    );
    return { ...p, file: phone };
  });
  const png = path.join(TMP, `${theme}.png`);
  const args = [
    "-size", `${W}x${H}`, "-define", "gradient:center=720,440", "-define", "gradient:radii=660,380",
    `radial-gradient:${t.glow}${t.glowAlpha}-${t.glow}00`, "-gravity", "center",
  ];
  for (const p of [...phones].sort((a, b) => a.z - b.z))
    args.push(p.file, "-geometry", `${off(p.x - W / 2)}${off(p.top + 322.5 - H / 2 + 8)}`, "-compose", "Over", "-composite");
  magick(...args, png);
  const out = path.join(OUT, `showcase-${theme}.webp`);
  execFileSync("cwebp", ["-quiet", "-q", "80", "-alpha_q", "80", "-m", "6", png, "-o", out]);
  console.log(`${path.basename(out)}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
}
fs.rmSync(TMP, { recursive: true, force: true });

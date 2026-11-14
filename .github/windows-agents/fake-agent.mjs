// Stands in for an agent program in the Windows CI test (windows-agents/e2e.ts): says it is
// ready and in which folder, then echoes each line it is sent ("got: ...") and names the
// keys it gets ("got key: esc"), so the test can read the effect of everything it sends.
import { basename } from "node:path";

const out = (s) => process.stdout.write(s);
out(`fake agent ready, in: ${basename(process.cwd())}\r\n`);
if (process.argv.length > 2) out(`args: ${process.argv.slice(2).join(" ")}\r\n`);
out("> ");

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let line = "";
process.stdin.on("data", (chunk) => {
  for (const ch of chunk.replace(/\x1b\[20[01]~/g, "")) {
    if (ch === "\r" || ch === "\n") {
      if (line) out(`\r\ngot: ${line}\r\n> `);
      line = "";
    } else if (ch === "\x1b") out("\r\ngot key: esc\r\n> ");
    else if (ch === "\x03") out("\r\ngot key: ctrl+c\r\n> ");
    else if (ch === "\x7f" || ch === "\b") line = line.slice(0, -1);
    else if (ch >= " ") {
      line += ch;
      out(ch);
    }
  }
});

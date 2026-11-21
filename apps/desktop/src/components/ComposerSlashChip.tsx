import { X } from "lucide-react";
import type { SlashCommandItem } from "@herdr-pocket/protocol";
import { slashCommandIconKind } from "../lib/slashCommands";
import { SlashKindIcon } from "./SlashCommandPopup";
import "../styles/btw-slash.css";

export const COMPOSER_SLASH_CHIP_PLACEHOLDER = "补充参数或说明，Backspace 可拆开命令…";

export function slashChipCategoryHint(command: SlashCommandItem): "旁路" | "技能" | "命令" {
  if (command.name.trim().toLowerCase() === "/btw") return "旁路";
  if (command.category === "skill") return "技能";
  return "命令";
}

export interface ComposerSlashChipProps {
  command: SlashCommandItem;
  onUnwrap: () => void;
  className?: string;
}

/**
 * Integrated inline soft-pink token inside `.composer-input-wrap` for a leading `/skill` or `/command`.
 * Aligns cleanly with line 1 of the composer textarea without nested pill chrome.
 */
export function ComposerSlashChip({ command, onUnwrap, className = "" }: ComposerSlashChipProps) {
  const kind = slashCommandIconKind(command);
  const cat = command.category ?? "session";
  const hint = slashChipCategoryHint(command);
  const isBtw = command.name.trim().toLowerCase() === "/btw";

  return (
    <span
      className={`composer-slash-chip${className ? ` ${className}` : ""}`}
      data-cat={cat}
      data-btw={isBtw ? "true" : undefined}
      title={command.description ? `${command.name} · ${command.description}` : command.name}
    >
      <span className="composer-slash-ic" data-cat={cat} aria-hidden="true">
        <SlashKindIcon kind={kind} size={12} />
      </span>
      <span className="composer-slash-name mono truncate">{command.name}</span>
      <span className="composer-slash-sub" aria-hidden="true">· {hint}</span>
      <button
        type="button"
        className="composer-slash-x"
        aria-label={`拆开 ${command.name} 命令`}
        title="拆开为普通文本 (Backspace)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onUnwrap}
      >
        <X size={11} />
      </button>
    </span>
  );
}

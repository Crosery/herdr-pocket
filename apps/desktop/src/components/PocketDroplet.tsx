import { AlertTriangle, ArrowRight, Check, HelpCircle, ShieldAlert, X } from "lucide-react";
import {
  ATTENTION_CATEGORY_META,
  attentionStore,
  dismissAttentionPeek,
  jumpToAttentionAgent,
  type AttentionCategory,
} from "../lib/attentionCenter";
import { settingsStore } from "../lib/store";
import { XiaoyangOrb } from "./MascotAndVendor";

function CategoryIcon({ category }: { category: AttentionCategory }) {
  switch (category) {
    case "approval":
      return <ShieldAlert size={11} />;
    case "question":
      return <HelpCircle size={11} />;
    case "error":
      return <AlertTriangle size={11} />;
    case "completed":
      return <Check size={11} />;
  }
}

export function PocketDroplet() {
  const notifications = settingsStore.use((s) => s.notifications);
  const peek = attentionStore.use((s) => s.peek);
  const totalCount = attentionStore.use((s) => s.items.length);

  if (!notifications || !peek) return null;

  const meta = ATTENTION_CATEGORY_META[peek.category];
  const mascotMood = peek.category === "completed" ? "idle" : "waiting";

  return (
    <div className="v3-droplet-wrap" role="status" aria-live="polite">
      <div className={`v3-droplet is-${peek.category}`}>
        <XiaoyangOrb mood={mascotMood} size={22} />
        <button
          type="button"
          className="v3-droplet-main"
          onClick={() => jumpToAttentionAgent(peek.agentKey)}
        >
          <span className={`v3-droplet-tag is-${peek.category}`}>
            <CategoryIcon category={peek.category} />
            <span>{meta.label}</span>
          </span>
          <span className="v3-droplet-title truncate">{peek.title}</span>
          <span className="v3-droplet-sub truncate">{peek.subtitle}</span>
          {totalCount > 1 ? <span className="v3-droplet-count">+{totalCount - 1}</span> : null}
          <ArrowRight size={12} />
        </button>
        <button
          type="button"
          className="v3-droplet-close"
          aria-label="关闭提醒胶囊"
          onClick={() => dismissAttentionPeek()}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

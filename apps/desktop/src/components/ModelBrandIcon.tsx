import { useId, type CSSProperties } from "react";
import { Cpu } from "lucide-react";
import { MODEL_BRAND_ICONS, resolveModelBrand } from "@herdr-pocket/protocol";

export interface ModelBrandIconProps {
  model?: string | null;
  provider?: string | null;
  label?: string | null;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Renders the official AI vendor/model brand icon for a model slug or provider,
 * falling back to Lucide `<Cpu />` when no brand match exists.
 */
export function ModelBrandIcon({
  model,
  provider,
  label,
  size = 14,
  className,
  style,
}: ModelBrandIconProps) {
  const uid = useId().replace(/:/g, "");
  const brandId = resolveModelBrand(model, { provider, label });
  if (!brandId) {
    return (
      <Cpu
        size={size}
        className={className}
        style={{ flexShrink: 0, ...style }}
        aria-hidden="true"
      />
    );
  }
  const spec = MODEL_BRAND_ICONS[brandId];
  return (
    <svg
      width={size}
      height={size}
      viewBox={spec.viewBox}
      fill={spec.defaultFill ?? "none"}
      fillRule={spec.defaultFillRule as "evenodd" | "nonzero" | undefined}
      className={className ? `model-brand-icon ${className}` : "model-brand-icon"}
      style={{ flexShrink: 0, display: "inline-block", verticalAlign: "middle", ...style }}
      aria-hidden="true"
    >
      {spec.gradients?.length ? (
        <defs>
          {spec.gradients.map((g) => (
            <linearGradient
              key={g.localId}
              id={`${uid}-${g.localId}`}
              x1={g.x1}
              y1={g.y1}
              x2={g.x2}
              y2={g.y2}
              gradientUnits={g.gradientUnits as "userSpaceOnUse" | "objectBoundingBox" | undefined}
            >
              {g.stops.map((s, idx) => (
                <stop
                  key={idx}
                  offset={s.offset}
                  stopColor={s.color}
                  stopOpacity={s.opacity}
                />
              ))}
            </linearGradient>
          ))}
        </defs>
      ) : null}
      {spec.elements.map((el, idx) => {
        const fill = el.fillGradient ? `url(#${uid}-${el.fillGradient})` : el.fill;
        if (el.tag === "path") {
          return (
            <path
              key={idx}
              d={el.d}
              fill={fill}
              fillRule={el.fillRule as "evenodd" | "nonzero" | undefined}
              clipRule={el.clipRule as "evenodd" | "nonzero" | undefined}
              fillOpacity={el.fillOpacity}
            />
          );
        }
        if (el.tag === "circle") {
          return (
            <circle
              key={idx}
              cx={el.cx}
              cy={el.cy}
              r={el.r}
              fill={fill}
              fillOpacity={el.fillOpacity}
            />
          );
        }
        return (
          <ellipse
            key={idx}
            cx={el.cx}
            cy={el.cy}
            rx={el.rx}
            ry={el.ry}
            fill={fill}
            fillOpacity={el.fillOpacity}
          />
        );
      })}
    </svg>
  );
}

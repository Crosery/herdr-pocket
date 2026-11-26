import { useId } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, Stop } from "react-native-svg";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { MODEL_BRAND_ICONS, resolveModelBrand } from "@herdr-pocket/protocol";

export interface ModelBrandIconProps {
  model?: string | null;
  provider?: string | null;
  label?: string | null;
  size?: number;
  color: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Renders the official AI vendor/model brand icon using react-native-svg,
 * substituting `color` on monochrome paths and falling back to `cpu-64-bit`.
 */
export function ModelBrandIcon({
  model,
  provider,
  label,
  size = 14,
  color,
  style,
}: ModelBrandIconProps) {
  const uid = useId().replace(/:/g, "");
  const brandId = resolveModelBrand(model, { provider, label });
  if (!brandId) {
    return (
      <MaterialCommunityIcons
        name="cpu-64-bit"
        size={size}
        color={color}
        style={[{ flexShrink: 0 }, style as any]}
      />
    );
  }
  const spec = MODEL_BRAND_ICONS[brandId];
  const rootFill = spec.defaultFill === "currentColor" ? color : (spec.defaultFill ?? "none");
  return (
    <View style={[{ width: size, height: size, alignItems: "center", justifyContent: "center", flexShrink: 0 }, style]}>
      <Svg
        width={size}
        height={size}
        viewBox={spec.viewBox}
        fill={rootFill}
        fillRule={spec.defaultFillRule as "evenodd" | "nonzero" | undefined}
      >
        {spec.gradients?.length ? (
          <Defs>
            {spec.gradients.map((g) => (
              <LinearGradient
                key={g.localId}
                id={`${uid}-${g.localId}`}
                x1={g.x1}
                y1={g.y1}
                x2={g.x2}
                y2={g.y2}
                gradientUnits={g.gradientUnits as "userSpaceOnUse" | "objectBoundingBox" | undefined}
              >
                {g.stops.map((s, idx) => (
                  <Stop
                    key={idx}
                    offset={s.offset}
                    stopColor={s.color}
                    stopOpacity={s.opacity}
                  />
                ))}
              </LinearGradient>
            ))}
          </Defs>
        ) : null}
        {spec.elements.map((el, idx) => {
          const rawFill = el.fill === "currentColor" ? color : el.fill;
          const fill = el.fillGradient ? `url(#${uid}-${el.fillGradient})` : rawFill;
          if (el.tag === "path") {
            return (
              <Path
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
              <Circle
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
            <Ellipse
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
      </Svg>
    </View>
  );
}

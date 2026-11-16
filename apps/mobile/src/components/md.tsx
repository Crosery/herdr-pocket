/**
 * Markdown for chat bubbles, rendered the way react-native-markdown-display's <Markdown> does it,
 * minus its per-render setup. <Markdown> builds a new markdown-it parser and a new renderer (merging
 * some 40 style objects) every time it renders, because its default props are fresh objects on each
 * render. Here one parser serves every message and one renderer serves every message with the same
 * look, so a message only pays for parsing its own text.
 */
import { memo } from "react";
import { StyleSheet, Text } from "react-native";
import * as MarkdownDisplay from "react-native-markdown-display";
import { AstRenderer, MarkdownIt, parser, renderRules } from "react-native-markdown-display";

type StyleMap = Record<string, object>;

// Exported by the library but missing from its type declarations.
const lib = MarkdownDisplay as unknown as { styles: StyleMap; removeTextStyleProps: (s: object) => object };
const Renderer = AstRenderer as unknown as new (
  rules: typeof renderRules,
  style: StyleMap,
  onLinkPress: undefined,
  maxTopLevelChildren: null,
  topLevelMaxExceededItem: React.ReactNode,
  allowedImageHandlers: string[],
  defaultImageHandler: string,
  debugPrintTree: boolean,
) => AstRenderer;

/** The parser <Markdown> uses by default. */
const PARSER = MarkdownIt({ typographer: true });
const IMAGE_HANDLERS = ["data:image/png;base64", "data:image/gif;base64", "data:image/jpeg;base64", "https://", "http://"];
const TOO_LONG = <Text key="dotdotdot">...</Text>;

const renderers = new WeakMap<object, AstRenderer>();

/** <Markdown>'s renderer for a style (its getStyle with mergeStyle on), made once per style object. */
function rendererFor(style: StyleMap): AstRenderer {
  let r = renderers.get(style);
  if (r) return r;
  const merged: StyleMap = {};
  for (const k of Object.keys(style)) merged[k] = { ...StyleSheet.flatten(style[k]) };
  for (const k of Object.keys(lib.styles)) merged[k] = { ...lib.styles[k], ...StyleSheet.flatten(style[k]) };
  for (const k of Object.keys(merged)) merged[`_VIEW_SAFE_${k}`] = lib.removeTextStyleProps(merged[k]!);
  r = new Renderer({ ...renderRules }, StyleSheet.create(merged), undefined, null, TOO_LONG, IMAGE_HANDLERS, "https://", false);
  renderers.set(style, r);
  return r;
}

/** Markdown text; pass the same `style` object for the same look (see `mdStyles`) so the renderer is shared. */
export const Md = memo(function Md({ children, style }: { children: string; style: StyleMap }): React.ReactNode {
  // The library's declarations type the render callback as taking one node; it gets the node list, as <Markdown> passes it.
  const render = rendererFor(style).render as unknown as Parameters<typeof parser>[1];
  return parser(children, render, PARSER);
});

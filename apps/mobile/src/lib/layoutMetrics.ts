/**
 * Pure responsive layout calculations for mobile viewports (`320pt`–`1024pt`).
 * Kept free of React Native runtime imports so it can be unit-tested directly in Node.
 */

export interface ComposerBarMetrics {
  outerMargin: number;
  cardPadX: number;
  itemGap: number;
  iconBtnSize: number;
  pillHeight: number;
  pillPadX: number;
  modelMinW: number;
  modelMaxW: number;
  thinkingMinW: number;
  thinkingMaxW: number;
  showModelIcon: boolean;
  allowThinkingShrink: boolean;
  actionHeight: number;
  actionPadX: number;
  sendWidth: number;
  /** Worst-case width reserved for the right primary action ("停止"/"排队"/SendPill). */
  rightActionReserve: number;
  /** Inner content width inside the composer card (excluding outer margins, borders, and card padding). */
  innerCardWidth: number;
}

/**
 * Computes responsive dimensions for the chat/terminal composer bar so the right
 * primary action never overflows off-screen across `320–1024pt` widths and `0.85–1.3×` text scales.
 */
export function computeComposerBarMetrics(windowWidth: number, textScale: number): ComposerBarMetrics {
  const w = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 390;
  const ts = Number.isFinite(textScale) && textScale > 0 ? Math.min(1.6, Math.max(0.75, textScale)) : 1;

  const outerMargin = w < 360 ? 10 : w < 380 ? 12 : 16;
  const cardPadX = 6;
  const borderOverhead = 2;
  const innerCardWidth = Math.max(200, Math.floor(w - outerMargin * 2 - cardPadX * 2 - borderOverhead));

  const itemGap = w < 360 ? 4 : w < 390 ? 5 : w < 430 ? 6 : 8;
  const iconBtnSize = w < 360 ? 36 : w < 390 ? 38 : w < 430 ? 40 : 42;
  const pillHeight = 36;
  const pillPadX = w < 360 ? 7 : w < 390 ? 8 : 10;

  const actionHeight = w < 360 ? 38 : w < 430 ? 40 : 42;
  const sendWidth = w < 360 ? 48 : w < 430 ? 52 : 54;
  const actionPadX = w < 360 || ts > 1.15 ? 11 : w < 410 ? 12 : 14;
  // Reserve at least the widest action pill ("停止" / "排队"): padX*2 + 16px icon + 5px gap + scaled text.
  const rightActionReserve = Math.max(sendWidth, actionPadX * 2 + 16 + 5 + Math.ceil(30 * ts));

  // Four gaps sit between: [keyboard, image, model, thinking, rightAction].
  const availableForPills = Math.max(96, innerCardWidth - iconBtnSize * 2 - itemGap * 4 - rightActionReserve);

  const showModelIcon = w >= 375 && !(w < 390 && ts > 1.2);
  const allowThinkingShrink = w < 600;

  const thinkingMaxW = w < 360 ? 72 : w < 390 ? 82 : w < 430 ? 92 : 104;
  const modelMaxW = w < 360 ? 104 : w < 390 ? 124 : w < 420 ? 140 : w < 600 ? 164 : 220;

  const rawThinkingMinW = w < 360 ? 44 : w < 390 ? 48 : w < 430 ? 54 : 58;
  const rawModelMinW = w < 360 ? 56 : w < 390 ? 64 : w < 430 ? 72 : 80;

  const thinkingMinW = Math.min(
    thinkingMaxW,
    Math.max(38, Math.min(rawThinkingMinW, Math.floor(availableForPills * 0.42))),
  );
  const modelMinW = Math.min(
    modelMaxW,
    Math.max(48, Math.min(rawModelMinW, availableForPills - thinkingMinW)),
  );

  return {
    outerMargin,
    cardPadX,
    itemGap,
    iconBtnSize,
    pillHeight,
    pillPadX,
    modelMinW,
    modelMaxW,
    thinkingMinW,
    thinkingMaxW,
    showModelIcon,
    allowThinkingShrink,
    actionHeight,
    actionPadX,
    sendWidth,
    rightActionReserve,
    innerCardWidth,
  };
}

/**
 * Clamps floating composer popups (slash commands, model/thinking picker, usage card)
 * to the remaining space above the keyboard so they do not cover the header.
 */
export function computePopupMaxHeight(windowHeight: number, keyboardHeight: number): number {
  const h = Number.isFinite(windowHeight) && windowHeight > 0 ? windowHeight : 844;
  const kb = Number.isFinite(keyboardHeight) && keyboardHeight > 0 ? keyboardHeight : 0;
  const available = Math.max(0, h - kb - 220);
  return Math.max(120, Math.min(340, Math.round(available * 0.65)));
}

/**
 * Computes the horizontal spacing between the 3 circular call controls (`3 × 84pt`)
 * so they remain centered without clipping on `320–360pt` screens or landscape cutouts.
 */
export function computeCallControlsGap(windowWidth: number): number {
  const w = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 390;
  if (w < 350) return 12;
  if (w < 375) return 22;
  if (w < 400) return 30;
  if (w < 430) return 36;
  return 40;
}

/** Ensures horizontal padding clears safe-area cutouts (e.g. landscape Dynamic Island). */
export function horizontalPad(basePad: number, insetSide: number): number {
  const base = Number.isFinite(basePad) && basePad > 0 ? basePad : 0;
  const inset = Number.isFinite(insetSide) && insetSide > 0 ? insetSide : 0;
  return Math.max(base, inset);
}

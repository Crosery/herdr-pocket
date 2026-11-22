import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCallControlsGap,
  computeComposerBarMetrics,
  computePopupMaxHeight,
  horizontalPad,
} from "../src/lib/layoutMetrics.ts";

const VIEWPORT_WIDTHS = [320, 360, 375, 390, 393, 402, 412, 430, 440, 744, 834, 1024] as const;
const TEXT_SCALES = [0.85, 1, 1.15, 1.3] as const;

test("computeComposerBarMetrics guarantees zero horizontal overflow across all viewports and text scales", () => {
  for (const width of VIEWPORT_WIDTHS) {
    for (const scale of TEXT_SCALES) {
      const m = computeComposerBarMetrics(width, scale);

      assert.ok(m.outerMargin > 0, `outerMargin positive at w=${width}`);
      assert.ok(m.iconBtnSize >= 36 && m.iconBtnSize <= 42, `iconBtnSize in range at w=${width}`);
      assert.ok(m.actionHeight >= 38 && m.actionHeight <= 42, `actionHeight in range at w=${width}`);
      assert.ok(m.sendWidth >= 48 && m.sendWidth <= 54, `sendWidth in range at w=${width}`);
      assert.ok(m.modelMinW > 0 && m.modelMinW <= m.modelMaxW, `model bounds valid at w=${width}, ts=${scale}`);
      assert.ok(m.thinkingMinW > 0 && m.thinkingMinW <= m.thinkingMaxW, `thinking bounds valid at w=${width}, ts=${scale}`);

      // Card total width (outer margins + borders + card horizontal padding + inner content) fits within viewport.
      const cardOuterWidth = m.innerCardWidth + m.cardPadX * 2 + 2;
      assert.ok(
        cardOuterWidth + m.outerMargin * 2 <= width,
        `card width ${cardOuterWidth} + margins exceeds viewport ${width}`,
      );

      // Minimum toolbar width (2 icons + modelMin + thinkingMin + 4 gaps + worst-case right action) fits inner card.
      const minRequiredWidth =
        m.iconBtnSize * 2 +
        m.modelMinW +
        m.thinkingMinW +
        m.itemGap * 4 +
        m.rightActionReserve;
      assert.ok(
        minRequiredWidth <= m.innerCardWidth,
        `composer bar minimum width ${minRequiredWidth} > innerCardWidth ${m.innerCardWidth} at w=${width}, ts=${scale}`,
      );

      // Compactness flags match viewport expectations.
      if (width < 375) {
        assert.equal(m.showModelIcon, false, `model icon hidden below 375pt (w=${width})`);
      } else if (width >= 402) {
        assert.equal(m.showModelIcon, true, `model icon visible at w=${width}`);
      }

      if (width <= 440) {
        assert.equal(m.allowThinkingShrink, true, `thinking pill can shrink on phone w=${width}`);
      } else {
        assert.equal(m.allowThinkingShrink, false, `thinking pill does not shrink on tablet w=${width}`);
      }
    }
  }
});

test("computeComposerBarMetrics handles non-finite inputs defensively", () => {
  const fallback = computeComposerBarMetrics(Number.NaN, Number.NaN);
  assert.ok(fallback.innerCardWidth > 0);
  assert.ok(fallback.modelMinW <= fallback.modelMaxW);
});

test("computePopupMaxHeight scales monotonically and respects keyboard height", () => {
  const heights = [568, 667, 844, 852, 874, 932, 1024];
  const keyboards = [0, 216, 260, 336, 380];

  for (const h of heights) {
    let prevForKeyboard = Infinity;
    for (const kb of keyboards) {
      const maxH = computePopupMaxHeight(h, kb);
      assert.ok(maxH >= 120 && maxH <= 340, `popup maxHeight ${maxH} within [120, 340] for h=${h}, kb=${kb}`);
      assert.ok(maxH <= prevForKeyboard, `popup maxHeight increased with larger keyboard at h=${h}, kb=${kb}`);
      prevForKeyboard = maxH;
      if (kb > 0 && h - kb > 180) {
        assert.ok(maxH < h - kb, `popup maxHeight ${maxH} leaves room above keyboard at h=${h}, kb=${kb}`);
      }
    }
  }

  for (const kb of keyboards) {
    let prevForHeight = 0;
    for (const h of heights) {
      const maxH = computePopupMaxHeight(h, kb);
      assert.ok(maxH >= prevForHeight, `popup maxHeight decreased with taller viewport at h=${h}, kb=${kb}`);
      prevForHeight = maxH;
    }
  }
});

test("computeCallControlsGap keeps all 3 call buttons inside every viewport width", () => {
  const BUTTON_WIDTH = 84;
  const HORIZONTAL_PADDING = 32; // 16pt each side
  let prevGap = 0;

  for (const width of VIEWPORT_WIDTHS) {
    const gap = computeCallControlsGap(width);
    const totalRowWidth = BUTTON_WIDTH * 3 + gap * 2 + HORIZONTAL_PADDING;
    assert.ok(gap > 0, `positive call gap at w=${width}`);
    assert.ok(gap >= prevGap, `call gap non-decreasing at w=${width}`);
    assert.ok(totalRowWidth <= width, `call controls width ${totalRowWidth} > viewport ${width}`);
    prevGap = gap;
  }
});

test("horizontalPad preserves base padding and respects larger safe-area insets", () => {
  assert.equal(horizontalPad(16, 0), 16);
  assert.equal(horizontalPad(16, 12), 16);
  assert.equal(horizontalPad(16, 59), 59);
  assert.equal(horizontalPad(10, 44), 44);
  assert.equal(horizontalPad(16, -8), 16);
  assert.equal(horizontalPad(16, Number.NaN), 16);
});

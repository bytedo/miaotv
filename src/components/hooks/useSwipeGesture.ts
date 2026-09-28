import { useCallback, useRef } from 'react';

interface UseSwipeGestureOptions {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  minSwipeDistance?: number;
}

interface SwipeGestureHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchCancel: () => void;
}

interface SwipePosition {
  identifier: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * 滑动手势 Hook（移动端触摸支持）
 *
 * @param onSwipeLeft - 左滑回调（切换到下一项）
 * @param onSwipeRight - 右滑回调（切换到上一项）
 * @param minSwipeDistance - 最小滑动距离（像素），默认 50
 * @returns 触摸事件处理函数
 */
export function useSwipeGesture({
  onSwipeLeft,
  onSwipeRight,
  minSwipeDistance = 50,
}: UseSwipeGestureOptions): SwipeGestureHandlers {
  const position = useRef<SwipePosition | null>(null);
  const onTouchCancel = useCallback(() => {
    position.current = null;
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    position.current = null;
    if (e.touches.length !== 1) return;
    const control = (e.target as Element).closest(
      'button, a[href], input, select, textarea, [role="button"], [data-button]',
    );
    if (control && control !== e.currentTarget) return;

    const touch = e.touches[0];
    position.current = {
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      endX: touch.clientX,
      endY: touch.clientY,
    };
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const start = position.current;
    if (!start) return;
    const touch = e.touches[0];
    if (e.touches.length !== 1 || touch.identifier !== start.identifier) {
      position.current = null;
      return;
    }

    const distanceX = Math.abs(touch.clientX - start.startX);
    const distanceY = Math.abs(touch.clientY - start.startY);
    // Once scrolling starts, leave this gesture to the browser. Refs avoid
    // rendering the entire banner on every touchmove.
    if (distanceY > 10 && distanceY > distanceX) {
      position.current = null;
      return;
    }
    start.endX = touch.clientX;
    start.endY = touch.clientY;
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = position.current;
      position.current = null;
      if (!start || e.touches.length > 0) return;
      const touch = e.changedTouches[0];
      if (touch && touch.identifier !== start.identifier) return;
      const distanceX = start.startX - (touch?.clientX ?? start.endX);
      const distanceY = start.startY - (touch?.clientY ?? start.endY);
      if (
        Math.abs(distanceX) <= minSwipeDistance ||
        Math.abs(distanceX) <= Math.abs(distanceY)
      )
        return;

      if (distanceX > 0) onSwipeLeft();
      else onSwipeRight();
    },
    [minSwipeDistance, onSwipeLeft, onSwipeRight],
  );

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  };
}

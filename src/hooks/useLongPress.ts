import { useCallback, useEffect, useRef } from 'react';

interface UseLongPressOptions {
  onLongPress: () => void;
  onClick?: () => void;
  longPressDelay?: number;
  moveThreshold?: number;
}

interface TouchPosition {
  x: number;
  y: number;
}

export const useLongPress = ({
  onLongPress,
  onClick,
  longPressDelay = 500,
  moveThreshold = 10,
}: UseLongPressOptions) => {
  const isLongPress = useRef(false);
  const pressTimer = useRef<NodeJS.Timeout | null>(null);
  const startPosition = useRef<TouchPosition | null>(null);
  const isActive = useRef(false); // 防止重复触发
  const wasButton = useRef(false); // 记录触摸开始时是否是按钮

  const clearTimer = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  const resetGesture = useCallback(() => {
    clearTimer();
    isLongPress.current = false;
    startPosition.current = null;
    isActive.current = false;
    wasButton.current = false;
  }, [clearTimer]);

  useEffect(() => resetGesture, [resetGesture]);

  const handleStart = useCallback(
    (clientX: number, clientY: number, isButton = false) => {
      // 如果已经有活跃的手势，忽略新的开始
      if (isActive.current) {
        return;
      }

      // Let nested controls receive their native click, including SVG children.
      wasButton.current = isButton;
      if (isButton) return;

      isActive.current = true;
      isLongPress.current = false;
      startPosition.current = { x: clientX, y: clientY };

      pressTimer.current = setTimeout(() => {
        // 再次检查是否仍然活跃
        if (!isActive.current) return;

        isLongPress.current = true;

        if (navigator.vibrate) {
          navigator.vibrate(50);
        }

        // 触发长按事件
        onLongPress();
      }, longPressDelay);
    },
    [onLongPress, longPressDelay],
  );

  const handleMove = useCallback(
    (clientX: number, clientY: number) => {
      if (!startPosition.current || !isActive.current) return;

      const distance = Math.sqrt(
        Math.pow(clientX - startPosition.current.x, 2) +
          Math.pow(clientY - startPosition.current.y, 2),
      );

      // 如果移动距离超过阈值，取消长按
      if (distance > moveThreshold) {
        clearTimer();
        isActive.current = false;
      }
    },
    [clearTimer, moveThreshold],
  );

  const handleEnd = useCallback(() => {
    // 根据情况决定是否触发点击事件：
    // 1. 如果是长按，不触发点击
    // 2. 如果不是长按且触摸开始时是按钮，不触发点击
    // 3. 否则触发点击
    const shouldClick =
      !isLongPress.current && !wasButton.current && onClick && isActive.current;

    resetGesture();
    if (shouldClick) onClick();
  }, [resetGesture, onClick]);

  // 触摸事件处理器
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length !== 1) {
        resetGesture();
        return;
      }

      const target = e.target as Element;
      const control = target.closest(
        'button, a[href], input, select, textarea, [role="button"], [data-button]',
      );
      const isButton = !!control && control !== e.currentTarget;

      // 阻止默认的长按行为，但不阻止触摸开始事件
      const touch = e.touches[0];
      handleStart(touch.clientX, touch.clientY, !!isButton);
    },
    [handleStart, resetGesture],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length !== 1) {
        resetGesture();
        return;
      }
      const touch = e.touches[0];
      handleMove(touch.clientX, touch.clientY);
    },
    [handleMove, resetGesture],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      // Cancel the synthetic card click, but never swallow a nested control click.
      if (!wasButton.current) {
        e.preventDefault();
        e.stopPropagation();
      }
      handleEnd();
    },
    [handleEnd],
  );
  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel: resetGesture,
  };
};

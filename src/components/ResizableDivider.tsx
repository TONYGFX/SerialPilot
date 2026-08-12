/**
 * Desktop splitter used for adjustable workbench panes.
 * Pointer capture keeps dragging reliable even when the cursor leaves the
 * divider, while the document-level class prevents accidental text selection.
 */

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

type ResizableDividerProps = {
  orientation: "horizontal" | "vertical";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
};

/**
 * Renders a keyboard-accessible, pointer-draggable splitter.
 *
 * @param props Orientation, current size, bounds and update callback.
 * @returns A narrow divider with the appropriate resize cursor.
 */
export function ResizableDivider({ orientation, value, min, max, onChange, label }: ResizableDividerProps) {
  const pointerId = useRef<number>();
  const startPointer = useRef(0);
  const startValue = useRef(value);
  const axis = orientation === "horizontal" ? "clientY" : "clientX";

  useEffect(() => {
    const stopDragging = () => {
      if (pointerId.current === undefined) return;
      pointerId.current = undefined;
      document.body.classList.remove("is-resizing", "is-resizing-" + orientation);
    };
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    return () => {
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      document.body.classList.remove("is-resizing", "is-resizing-" + orientation);
    };
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    pointerId.current = event.pointerId;
    startPointer.current = event[axis];
    startValue.current = value;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing", "is-resizing-" + orientation);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    const delta = event[axis] - startPointer.current;
    const nextValue = orientation === "horizontal" ? startValue.current - delta : startValue.current + delta;
    onChange(Math.min(max, Math.max(min, nextValue)));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = undefined;
    document.body.classList.remove("is-resizing", "is-resizing-" + orientation);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const adjustWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = orientation === "horizontal"
      ? event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0
      : event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    onChange(Math.min(max, Math.max(min, value + direction * 16)));
  };

  return <div
    className={"resize-divider " + orientation}
    role="separator"
    aria-label={label}
    aria-orientation={orientation}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={Math.round(value)}
    tabIndex={0}
    onPointerDown={beginDrag}
    onPointerMove={moveDrag}
    onPointerUp={endDrag}
    onKeyDown={adjustWithKeyboard}
  />;
}

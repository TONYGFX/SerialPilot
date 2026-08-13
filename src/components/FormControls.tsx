/**
 * Reusable desktop form controls with application-owned dropdown and stepper visuals.
 * Native select and number popups are avoided so every platform follows SerialPilot's
 * scrollbar, focus and spacing rules.
 */

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export type SelectOption = { value: string; label: string };

type OptionPickerProps = { value: string; options: SelectOption[]; disabled?: boolean; onChange: (value: string) => void };
type NumberStepperProps = {
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel?: string;
  onChange: (value: number) => void;
};

/**
 * Renders a keyboard-addressable application dropdown with a consistent scrollbar.
 *
 * @param props Selected value, available options and selection callback.
 * @returns The dropdown control.
 */
export function OptionPicker({ value, options, disabled, onChange }: OptionPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    const closeWhenOutside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", closeWhenOutside);
    return () => document.removeEventListener("mousedown", closeWhenOutside);
  }, []);

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  return <div className="select-control" ref={root}>
    <button type="button" className={`select-trigger ${isOpen ? "open" : ""}`} disabled={disabled} aria-haspopup="listbox" aria-expanded={isOpen} onClick={() => setIsOpen((open) => !open)}>
      <span>{selected?.label ?? value}</span><span className="select-chevron"><Icon name="chevronDown" size={14} /></span>
    </button>
    {isOpen && <div className="select-menu" role="listbox" aria-label="选择选项">
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={`select-option ${option.value === value ? "selected" : ""}`} key={option.value} onClick={() => { onChange(option.value); setIsOpen(false); }}>{option.label}</button>)}
    </div>}
  </div>;
}

/**
 * Renders a bounded decimal input with compact increment and decrement buttons.
 *
 * @param props Numeric bounds, step size and update callback.
 * @returns The number stepper control.
 */
export function NumberStepper({ value, min, max, step, ariaLabel, onChange }: NumberStepperProps) {
  const [text, setText] = useState(() => formatNumber(value, step));
  const isEditing = useRef(false);

  useEffect(() => {
    if (!isEditing.current) setText(formatNumber(value, step));
  }, [step, value]);

  const commitText = () => {
    isEditing.current = false;
    const parsed = parseNumber(text);
    if (parsed === null) {
      setText(formatNumber(value, step));
      return;
    }
    const next = clamp(parsed, min, max);
    setText(formatNumber(next, step));
    if (next !== value) onChange(next);
  };
  const update = (delta: number) => {
    const parsed = parseNumber(text);
    const base = parsed === null ? value : clamp(parsed, min, max);
    const next = clamp(Number((base + delta).toFixed(decimalPlaces(step))), min, max);
    isEditing.current = false;
    setText(formatNumber(next, step));
    if (next !== value) onChange(next);
  };
  const updateFromText = (next: string) => {
    const normalized = next.replace(",", ".");
    if (/^\d*\.?\d*$/.test(normalized)) setText(normalized);
  };

  return <div className="stepper-control">
    <input
      type="text"
      inputMode="decimal"
      value={text}
      aria-label={ariaLabel ?? "数值"}
      aria-valuemin={min}
      aria-valuemax={max}
      onFocus={() => { isEditing.current = true; }}
      onChange={(event) => updateFromText(event.target.value)}
      onBlur={commitText}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
    <div className="stepper-buttons">
      <button type="button" className="stepper-button" aria-label="增加数值" onMouseDown={(event) => event.preventDefault()} onClick={() => update(step)}><Icon name="chevronUp" size={12} /></button>
      <button type="button" className="stepper-button" aria-label="减少数值" onMouseDown={(event) => event.preventDefault()} onClick={() => update(-step)}><Icon name="chevronDown" size={12} /></button>
    </div>
  </div>;
}

function parseNumber(text: string): number | null {
  if (text.trim() === "" || text.endsWith(".")) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function decimalPlaces(step: number): number {
  const [, fraction = ""] = String(step).split(".");
  return fraction.length;
}

function formatNumber(value: number, step: number): string {
  return String(Number(value.toFixed(decimalPlaces(step))));
}

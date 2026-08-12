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
  const update = (delta: number) => onChange(Math.min(max, Math.max(min, Number((value + delta).toFixed(2)))));
  const updateFromText = (text: string) => {
    const next = Number(text);
    if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
  };

  return <div className="stepper-control">
    <input type="text" inputMode="decimal" value={value} onChange={(event) => updateFromText(event.target.value)} aria-label={ariaLabel ?? "数值"} />
    <div className="stepper-buttons">
      <button type="button" className="stepper-button" aria-label="增加间隔" onClick={() => update(step)}><Icon name="chevronUp" size={12} /></button>
      <button type="button" className="stepper-button" aria-label="减少间隔" onClick={() => update(-step)}><Icon name="chevronDown" size={12} /></button>
    </div>
  </div>;
}

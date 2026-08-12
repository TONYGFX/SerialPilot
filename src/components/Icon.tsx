/**
 * Provides SerialPilot's compact line-icon set for tool controls.
 * Every icon uses the current text color, so the existing dark and light
 * workbench themes remain the single source of truth for visual state.
 */

import type { SVGProps } from "react";

export type IconName =
  | "arrowDown"
  | "arrowRight"
  | "channels"
  | "chevronDown"
  | "chevronUp"
  | "close"
  | "download"
  | "file"
  | "moon"
  | "pause"
  | "play"
  | "refresh"
  | "settings"
  | "sun"
  | "trash";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  name: IconName;
  size?: number;
};

const ICON_PATHS: Record<IconName, JSX.Element> = {
  arrowDown: <><path d="M9 3v9M5.5 8.5 9 12l3.5-3.5M4 14h10" /></>,
  arrowRight: <><path d="M3 8.5h9M8.5 5 12 8.5 8.5 12M14 4v9" /></>,
  channels: <><path d="M3 4h10M3 8h10M3 12h10" /><circle cx="15.5" cy="4" r=".8" fill="currentColor" stroke="none" /><circle cx="15.5" cy="8" r=".8" fill="currentColor" stroke="none" /><circle cx="15.5" cy="12" r=".8" fill="currentColor" stroke="none" /></>,
  chevronDown: <path d="m5 7 4 4 4-4" />,
  chevronUp: <path d="m5 11 4-4 4 4" />,
  close: <path d="m5 4 8 9M13 4l-8 9" />,
  download: <><path d="M9 3v8M6 8l3 3 3-3M4 14h10" /></>,
  file: <><path d="M5 2.5h5l3 3v9H5z" /><path d="M10 2.5v3h3M7 9h4M7 11.5h4" /></>,
  moon: <path d="M12.7 13.5A5.8 5.8 0 0 1 5.4 6.2 5.9 5.9 0 1 0 12.7 13.5Z" />,
  pause: <><path d="M6 5v7M11 5v7" /></>,
  play: <path d="m6 4 6 4.5L6 13V4Z" fill="currentColor" stroke="none" />,
  refresh: <><path d="M13 6.5A5 5 0 1 0 14 10M13 3.5v3h-3" /></>,
  settings: <><circle cx="9" cy="8.5" r="2.2" /><path d="M9 3.2v1.2M9 12.6v1.2M14.3 8.5h-1.2M4.9 8.5H3.7M12.8 4.7l-.9.9M6.1 11.4l-.9.9M12.8 12.3l-.9-.9M6.1 5.6l-.9-.9" /></>,
  sun: <><circle cx="9" cy="8.5" r="2.7" /><path d="M9 1.8v1.5M9 13.7v1.5M15.7 8.5h-1.5M3.8 8.5H2.3M13.7 3.8l-1.1 1.1M5.4 12.1l-1.1 1.1M13.7 13.2l-1.1-1.1M5.4 4.9 4.3 3.8" /></>,
  trash: <><path d="M4.5 5h9M7 3h4M6 5l.5 9h5L12 5M8 7.5v4M10 7.5v4" /></>,
};

/**
 * Renders one fixed-size, theme-aware tool icon.
 *
 * @param props Icon name, dimensions and standard SVG attributes.
 * @returns An inline SVG that inherits the surrounding text color.
 */
export function Icon({ name, size = 16, ...props }: IconProps) {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 18 17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{ICON_PATHS[name]}</svg>;
}

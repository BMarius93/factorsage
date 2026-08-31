import type { ComponentType } from "react";
import type { NavItemId } from "./navigation";

type NavIconProps = { readonly className?: string };

const SHARED_ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function StocksIcon({ className }: NavIconProps) {
  return (
    <svg {...SHARED_ICON_PROPS} className={className}>
      <path d="M4 19h16" />
      <path d="M7 16V9m5 7V5m5 11v-5" />
    </svg>
  );
}

function ListsIcon({ className }: NavIconProps) {
  return (
    <svg {...SHARED_ICON_PROPS} className={className}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth={2.6} />
    </svg>
  );
}

function StrategiesIcon({ className }: NavIconProps) {
  return (
    <svg {...SHARED_ICON_PROPS} className={className}>
      <path d="M21 7l-8.5 8.5-4-4L3 17" />
      <path d="M15 7h6v6" />
    </svg>
  );
}

function BacktestsIcon({ className }: NavIconProps) {
  return (
    <svg {...SHARED_ICON_PROPS} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 1.8" />
    </svg>
  );
}

function MonitorsIcon({ className }: NavIconProps) {
  return (
    <svg {...SHARED_ICON_PROPS} className={className}>
      <path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

export const NAV_ICONS: Record<NavItemId, ComponentType<NavIconProps>> = {
  stocks: StocksIcon,
  lists: ListsIcon,
  strategies: StrategiesIcon,
  backtests: BacktestsIcon,
  monitors: MonitorsIcon,
};

export function AccountIcon({ className }: NavIconProps) {
  return (
    <svg {...SHARED_ICON_PROPS} className={className}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M4.8 19.5a7.4 7.4 0 0114.4 0" />
    </svg>
  );
}

import type { ButtonHTMLAttributes, ReactNode, JSX } from "react";

type Size = "xs" | "sm" | "md";
type Variant = "default" | "ghost";

// 新的无界原语：用 children 和 number size
interface IconButtonNewProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: number; // px hit-target; icon sizes itself. Default 44 (wide top bar).
  active?: boolean;
  children: ReactNode; // an svg
  icon?: never;
  variant?: never;
}

// 旧的 API（保持向后兼容）：用 icon 和字符串 size
interface IconButtonLegacyProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string;
  icon: ReactNode;
  size?: Size;
  variant?: Variant;
  active?: boolean;
  children?: never;
}

export type IconButtonProps = IconButtonNewProps | IconButtonLegacyProps;

// Legacy: Size mapping for old API
const SIZE_LEGACY: Record<Size, string> = {
  xs: "h-6 w-6", // 24px
  sm: "h-7 w-7", // 28px
  md: "h-8 w-8", // 32px
};

// Legacy: Base classes per variant
const VARIANT_BASE: Record<Variant, string> = {
  default: "border bg-surface",
  ghost: "bg-transparent",
};

// Legacy: Tone function for coloring
function toneLegacy(variant: Variant, active: boolean): string {
  if (variant === "default") {
    return active
      ? "border-accent text-fg-1"
      : "border-line text-fg-2 hover:border-fg-3 hover:text-fg-1";
  }
  // ghost
  return active
    ? "bg-field text-fg-1"
    : "text-fg-2 hover:bg-field hover:text-fg-1";
}

export function IconButton(
  props: IconButtonProps
): JSX.Element {
  // Discriminate: if icon prop exists, use legacy API
  if ("icon" in props && props.icon !== undefined) {
    const {
      icon,
      size = "md",
      variant = "ghost",
      active = false,
      className = "",
      type = "button",
      ...rest
    } = props as IconButtonLegacyProps;

    return (
      <button
        type={type}
        className={[
          "inline-flex shrink-0 items-center justify-center rounded-chip",
          "transition-[background-color,border-color,color] duration-150 ease-out",
          "disabled:opacity-30 disabled:pointer-events-none",
          SIZE_LEGACY[size],
          VARIANT_BASE[variant],
          toneLegacy(variant, active),
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      >
        <span aria-hidden="true">{icon}</span>
      </button>
    );
  }

  // New API: borderless primitive
  const {
    size = 44,
    active,
    className,
    children,
    ...rest
  } = props as IconButtonNewProps;

  return (
    <button
      {...rest}
      type="button"
      style={{ width: size, height: size }}
      className={
        "flex items-center justify-center rounded-[12px] transition-colors " +
        "text-fg-2 hover:bg-field hover:text-fg-1 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line " +
        (active ? "bg-accent-tint text-accent-strong " : "") +
        (className ?? "")
      }
    >
      {children}
    </button>
  );
}

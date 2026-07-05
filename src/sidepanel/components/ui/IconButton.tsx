import type { ButtonHTMLAttributes, ReactNode, JSX } from "react";

// 无界原语：用 children 和 number size
interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: number; // px hit-target; icon sizes itself. Default 44 (wide top bar).
  active?: boolean;
  children: ReactNode; // an svg
}

export function IconButton({
  size = 44,
  active,
  className,
  children,
  ...rest
}: IconButtonProps): JSX.Element {
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

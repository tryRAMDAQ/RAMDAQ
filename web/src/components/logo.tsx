import React from "react";

/** The Hedge Bots mark (web/public/logo.png). */
export function Logo({ size = 30, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <img
      src="/logo.png"
      alt="Hedge Bots"
      width={size}
      height={size}
      style={{ borderRadius: Math.round(size * 0.22), objectFit: "cover", verticalAlign: "middle", marginRight: Math.round(size * 0.3), display: "inline-block", ...style }}
    />
  );
}

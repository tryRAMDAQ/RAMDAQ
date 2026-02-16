import React, { useState } from "react";

/**
 * Hand-rolled SVG charts per the dataviz mark specs: bars <=24px with 4px
 * rounded data-ends (square at the baseline), 2px lines, >=8px end markers
 * with a 2px surface ring, hairline gridlines, direct labels in ink tokens
 * (text never wears the series color), and hover tooltips on every mark.
 */

const SURFACE = "#ffffff";
const INK = "#16151d";
const INK2 = "#565264";
const MUTED = "#8b8797";
const GRID = "rgba(22,21,29,0.09)";

// ---------------------------------------------------------------- BarList
export interface BarDatum { label: string; value: number; color: string; sub?: string; }

export function BarList({ data, unit = "CYCLE", height = 26 }: { data: BarDatum[]; unit?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.value), 1e-9);
  return (
    <div>
      {data.map((d, i) => {
        const w = Math.max(0.5, (d.value / max) * 100);
        return (
          <div
            key={d.label}
            style={{ display: "grid", gridTemplateColumns: "110px 1fr 74px", gap: 8, alignItems: "center", height, position: "relative" }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span style={{ fontSize: 11, color: INK2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</span>
            <div style={{ position: "relative", height: 14 }}>
              <div style={{ position: "absolute", inset: 0, borderLeft: `1px solid ${GRID}` }} />
              <div
                style={{
                  position: "absolute", left: 0, top: 0, bottom: 0, width: `${w}%`,
                  background: d.color, borderRadius: "0 4px 4px 0", // rounded data-end, square baseline
                  opacity: hover === null || hover === i ? 1 : 0.45,
                  transition: "width 400ms ease, opacity 150ms",
                }}
              />
            </div>
            <span className="mono" style={{ fontSize: 11, color: INK, textAlign: "right" }}>
              {d.value >= 1000 ? Math.round(d.value).toLocaleString("en-US") : d.value.toFixed(1)}
"use client"

/**
 * Month-over-month bar charts on the Signals page.
 *
 * Two stacked charts — one for signal count, one for engagement score
 * (sum of score_delta). Separate panels rather than a dual-axis chart
 * so each metric is read on its own scale without the eye having to
 * cross-reference two y-axes.
 *
 * Hover any month for exact values. Honours the Excluded toggle on the
 * page so the chart matches what's listed below it. Empty leading
 * months are dropped — workspaces with one month of activity don't see
 * 11 empty padding bars.
 */

import { useState } from "react"

interface MonthBucket { month: string; count: number; scoreSum: number }

const TEAL  = "#2BA98B"
const AMBER = "#F59E0B"

export function SignalsTrendChart({ data }: { data: MonthBucket[] }) {
  // Drop leading zero months so the chart focuses on the period when
  // data actually started flowing.
  const firstNonZero = data.findIndex(d => d.count > 0 || d.scoreSum > 0)
  const visible = firstNonZero === -1 ? data : data.slice(firstNonZero)
  if (visible.length === 0) return null

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <MonthlyBarChart
        data={visible}
        getValue={d => d.count}
        title="Signals — volume"
        unit="signal"
        color={TEAL}
      />
      <MonthlyBarChart
        data={visible}
        getValue={d => d.scoreSum}
        title="Signals — engagement"
        unit="score"
        color={AMBER}
      />
    </div>
  )
}

function MonthlyBarChart({
  data,
  getValue,
  title,
  unit,
  color,
}: {
  data:     MonthBucket[]
  getValue: (d: MonthBucket) => number
  title:    string
  unit:     string
  color:    string
}) {
  const [hover, setHover] = useState<number | null>(null)

  const values  = data.map(getValue)
  const dataMax = Math.max(1, ...values.map(v => Math.abs(v)))
  const { top: max, step } = niceScale(dataMax)
  // Tick positions at multiples of `step`, ending at `max`.
  const ticks   = Array.from({ length: max / step + 1 }, (_, i) => i * step)

  // Layout — viewBox-based for responsive scaling.
  const W       = 520
  const H       = 180
  const PAD_L   = 36
  const PAD_R   = 14
  const PAD_T   = 12
  const PAD_B   = 26
  const inner_w = W - PAD_L - PAD_R
  const inner_h = H - PAD_T - PAD_B
  const colW    = inner_w / data.length
  const barW    = Math.max(8, Math.min(28, colW * 0.6))

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />
        <h2 className="text-[12px] font-bold uppercase tracking-[0.10em] text-zinc-200">{title}</h2>
        <span className="ml-auto text-[11px] text-zinc-500">{data.length} months</span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        role="img"
        aria-label={`${title} bar chart by month`}
      >
        {/* Gridlines + y-axis labels — ticks land on multiples of 100. */}
        {ticks.map(t => {
          const y = PAD_T + inner_h - inner_h * (t / max)
          return (
            <g key={t}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="rgba(255,255,255,0.06)" />
              <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize="9" fill={color} opacity="0.75">
                {t.toLocaleString()}
              </text>
            </g>
          )
        })}

        {/* Bars + month labels */}
        {data.map((d, i) => {
          const v        = getValue(d)
          const cx       = PAD_L + colW * i + colW / 2
          // Negative values render below the baseline (rare — only happens
          // when a month is net-negative, e.g. lots of unsubscribes).
          const barH     = (Math.abs(v) / max) * inner_h
          const barY     = v < 0 ? PAD_T + inner_h : PAD_T + inner_h - barH
          const isHover  = hover === i
          return (
            <g
              key={d.month}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {/* Hover hit-area covering the whole column */}
              <rect
                x={PAD_L + colW * i}
                y={PAD_T}
                width={colW}
                height={inner_h}
                fill="transparent"
              />
              <rect
                x={cx - barW / 2}
                y={barY}
                width={barW}
                height={barH}
                fill={color}
                opacity={isHover ? 1 : 0.85}
                rx={2}
              />
              <text
                x={cx}
                y={H - 10}
                textAnchor="middle"
                fontSize="10"
                fill={isHover ? "#fff" : "rgba(255,255,255,0.55)"}
              >
                {formatMonth(d.month)}
              </text>
            </g>
          )
        })}

        {/* Tooltip */}
        {hover !== null && data[hover] && (() => {
          const d = data[hover]
          const v = getValue(d)
          const cx = PAD_L + colW * hover + colW / 2
          const tooltipW = 130
          const tooltipH = 36
          const left = Math.min(W - PAD_R - tooltipW, Math.max(PAD_L, cx - tooltipW / 2))
          const top  = PAD_T + 6
          return (
            <g pointerEvents="none">
              <rect x={left} y={top} width={tooltipW} height={tooltipH} rx={6}
                fill="rgba(11, 61, 46, 0.95)" stroke="rgba(255,255,255,0.10)" />
              <text x={left + 8} y={top + 14} fontSize="10" fill="#fff" fontWeight="600">
                {formatMonth(d.month, true)}
              </text>
              <text x={left + 8} y={top + 28} fontSize="10" fill={color}>
                {v.toLocaleString()} {unit}{v === 1 ? "" : "s"}
              </text>
            </g>
          )
        })()}
      </svg>
    </div>
  )
}

/**
 * Pick a chart-top + tick step where every gridline lands on a multiple
 * of 100. Step grows past 100 once a strict 100-step would produce too
 * many gridlines (any number ending in two zeros still satisfies "in
 * 100s" — 200, 500, 1000, etc).
 *
 *   max=130   → top=200,  step=100  (3 ticks: 0, 100, 200)
 *   max=600   → top=600,  step=100  (7 ticks: 0, 100, …, 600)
 *   max=1435  → top=1500, step=500  (4 ticks: 0, 500, 1000, 1500)
 */
function niceScale(dataMax: number): { top: number; step: number } {
  const niceTop = Math.max(100, Math.ceil(dataMax / 100) * 100)
  for (const step of [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]) {
    const top = Math.ceil(niceTop / step) * step
    if (top / step <= 6) return { top, step }
  }
  // Fallback for absurdly large values — pick a power-of-10 step that
  // gives ~5 ticks.
  const pow = Math.pow(10, Math.floor(Math.log10(niceTop)))
  return { top: Math.ceil(niceTop / pow) * pow, step: pow }
}

function formatMonth(yyyymm: string, full = false): string {
  const [y, m] = yyyymm.split("-")
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1))
  return d.toLocaleString("en-GB", {
    month: full ? "long" : "short",
    year:  full ? "numeric" : "2-digit",
  })
}

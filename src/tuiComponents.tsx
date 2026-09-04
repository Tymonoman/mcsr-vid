import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { formatTime } from "../remotion/format.js";
import { STAGE_LABELS, type StageEvent } from "./pipeline.js";
import type { Suggestion } from "./suggest.js";

// Pulled straight from remotion/overlay.source.css so the TUI reads as the same brand as the overlay.
export const COLORS = {
  panelEdge: "#0d0c10",
  panelEdgeLight: "#3c3844",
  crimson: "#e2483f",
  warped: "#35d6c4",
  gold: "#f0c93d",
  quartz: "#f3ede2",
  muted: "#8d8695",
  lead: "#6be08a",
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_WIDTH = 24;

function useSpinnerFrame(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((n) => (n + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER_FRAMES[i]!;
}

/** "Xm Ys" (or just "Ys" under a minute) from a millisecond duration. */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/** Only shown once percent clears a small threshold, to avoid a wild early estimate. */
function etaText(percent: number, startedAtMs: number | undefined): string | null {
  if (startedAtMs === undefined || percent <= 5) return null;
  const elapsed = Date.now() - startedAtMs;
  const remaining = (elapsed / percent) * (100 - percent);
  return `~${formatDuration(remaining)} left`;
}

function ProgressBar({
  percent,
  color,
  startedAtMs,
}: {
  percent: number;
  color: string;
  startedAtMs?: number;
}) {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH);
  const eta = etaText(percent, startedAtMs);
  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color={COLORS.panelEdgeLight}>{"░".repeat(BAR_WIDTH - filled)}</Text>
      <Text color={COLORS.muted}>
        {" "}
        {Math.round(percent)}%{eta ? ` · ${eta}` : ""}
      </Text>
    </Text>
  );
}

export function StageRow({ event }: { event: StageEvent }) {
  const spinnerFrame = useSpinnerFrame(event.status === "active");

  const icon =
    event.status === "pending" ? (
      <Text color={COLORS.muted}>○</Text>
    ) : event.status === "active" ? (
      <Text color={COLORS.warped}>{spinnerFrame}</Text>
    ) : event.status === "done" ? (
      <Text color={COLORS.lead}>✓</Text>
    ) : (
      <Text color={COLORS.crimson}>✗</Text>
    );

  const labelColor =
    event.status === "pending" ? COLORS.muted : event.status === "error" ? COLORS.crimson : COLORS.quartz;

  return (
    <Box flexDirection="column">
      <Box>
        {icon}
        <Text> </Text>
        <Text color={labelColor} bold={event.status === "active"}>
          {STAGE_LABELS[event.stage]}
        </Text>
        {event.percent !== undefined && event.status !== "pending" && (
          <Box marginLeft={2}>
            <ProgressBar
              percent={event.percent}
              color={event.status === "error" ? COLORS.crimson : COLORS.gold}
              startedAtMs={event.status === "active" ? event.startedAtMs : undefined}
            />
          </Box>
        )}
      </Box>
      {event.message && (
        <Box marginLeft={2}>
          <Text color={COLORS.muted} dimColor>
            {event.message}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Fixed-width so the columns line up down the list; long nicknames are clipped. */
function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

export function SuggestionRow({ suggestion, selected }: { suggestion: Suggestion; selected: boolean }) {
  const { metrics, bucket, score } = suggestion;
  const isClose = bucket === "close";
  const margin =
    metrics.finishMarginMs === null ? "  DNF" : `${(metrics.finishMarginMs / 1000).toFixed(2).padStart(5)}s`;
  return (
    <Box>
      <Text color={COLORS.gold}>{selected ? "❯ " : "  "}</Text>
      <Text color={isClose ? COLORS.lead : COLORS.gold}>{isClose ? "[CLOSE]" : "[CHAOS]"}</Text>
      <Text color={selected ? COLORS.quartz : COLORS.muted}>
        {" "}
        {metrics.matchId} {pad(`${metrics.players[0]} v ${metrics.players[1]}`, 30)}
      </Text>
      <Text color={COLORS.muted}> {formatTime(metrics.resultMs).padStart(9)}</Text>
      {/* The two numbers that decide whether a match is worth rendering. */}
      <Text color={isClose ? COLORS.warped : COLORS.muted}> Δ{margin}</Text>
      <Text color={isClose ? COLORS.muted : COLORS.crimson}> ☠{String(metrics.deaths).padStart(2)}</Text>
      <Text color={COLORS.muted}> {score.toFixed(2)}</Text>
    </Box>
  );
}

export function Header() {
  return (
    <Box borderStyle="round" borderColor={COLORS.panelEdgeLight} paddingX={2} marginBottom={1}>
      <Text color={COLORS.crimson} bold>
        MCSR
      </Text>
      <Text color={COLORS.quartz}> </Text>
      <Text color={COLORS.warped} bold>
        VID
      </Text>
      <Text color={COLORS.muted}> — match → Kdenlive project</Text>
    </Box>
  );
}

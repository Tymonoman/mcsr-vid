import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import React, { useEffect, useState } from "react";
import { Box, render, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  runPipeline,
  STAGE_LABELS,
  STAGE_ORDER,
  type PipelineResult,
  type StageEvent,
  type StageId,
} from "./pipeline.js";
import { listMatchStatuses, type MatchStatusEntry } from "./matchStatus.js";
import { readBatchList } from "./batchList.js";

// Pulled straight from remotion/overlay.source.css so the TUI reads as the same brand as the overlay.
const COLORS = {
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
      <Text color={COLORS.muted}> {Math.round(percent)}%{eta ? ` · ${eta}` : ""}</Text>
    </Text>
  );
}

function StageRow({ event }: { event: StageEvent }) {
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

function Header() {
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

function initialStages(): Record<StageId, StageEvent> {
  const entries = STAGE_ORDER.map((stage) => [stage, { stage, status: "pending" as const }] as const);
  return Object.fromEntries(entries) as Record<StageId, StageEvent>;
}

type Screen = "input" | "progress" | "summary" | "history" | "batchSummary";

interface BatchItemResult {
  entry: string;
  projectPath: string | null;
  error: string | null;
}

function App({ signal }: { signal: AbortSignal }) {
  const [screen, setScreen] = useState<Screen>("input");
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [stages, setStages] = useState<Record<StageId, StageEvent>>(initialStages);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [kdenliveStatus, setKdenliveStatus] = useState<"idle" | "opening" | "opened" | "error">("idle");
  const [kdenliveError, setKdenliveError] = useState<string | null>(null);
  const [history, setHistory] = useState<MatchStatusEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyIndex, setHistoryIndex] = useState(0);
  // null = single-match mode; a list = batch mode, run one entry at a time.
  const [batchEntries, setBatchEntries] = useState<string[] | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  const [batchResults, setBatchResults] = useState<BatchItemResult[]>([]);

  const openInKdenlive = (projectPath: string) => {
    setKdenliveStatus("opening");
    const proc = spawn("kdenlive", [projectPath], { detached: true, stdio: "ignore" });
    proc.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      setKdenliveError(
        code === "ENOENT" ? "kdenlive not found on PATH. Open the project manually." : err.message,
      );
      setKdenliveStatus("error");
    });
    proc.on("spawn", () => {
      setKdenliveStatus("opened");
      proc.unref();
      instance.unmount();
      process.exit(0);
    });
  };

  // A match ID/URL is never an existing path, so this disambiguates the two input kinds
  // without a separate screen or flag.
  const handleSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setInputError("Paste a match URL or ID, or the path to a list file.");
      return;
    }
    if (existsSync(trimmed)) {
      let entries: string[];
      try {
        entries = await readBatchList(trimmed);
      } catch (err) {
        setInputError((err as Error).message);
        return;
      }
      if (entries.length === 0) {
        setInputError(`No match entries found in ${trimmed}.`);
        return;
      }
      setBatchEntries(entries);
      setBatchIndex(0);
      setBatchResults([]);
    }
    setInputError(null);
    setScreen("progress");
  };

  useEffect(() => {
    if (screen !== "progress") return;
    let cancelled = false;
    const entry = batchEntries ? batchEntries[batchIndex]! : input.trim();
    const advanceBatch = (item: BatchItemResult) => {
      setBatchResults((prev) => [...prev, item]);
      if (batchIndex + 1 < batchEntries!.length) setBatchIndex(batchIndex + 1);
      else setScreen("batchSummary");
    };
    setStages(initialStages());
    runPipeline(entry, {
      signal,
      onEvent: (e) => {
        if (cancelled) return;
        setStages((prev) => ({ ...prev, [e.stage]: e }));
      },
    })
      .then((r) => {
        if (cancelled) return;
        if (batchEntries) {
          advanceBatch({ entry, projectPath: r.projectPath, error: null });
          return;
        }
        setResult(r);
        setScreen("summary");
      })
      .catch((err) => {
        if (cancelled) return;
        const message = (err as Error).message;
        if (batchEntries) {
          // One bad match doesn't abort the rest of the batch.
          advanceBatch({ entry, projectPath: null, error: message });
          return;
        }
        setRunError(message);
        setStages((prev) => {
          const active = STAGE_ORDER.find((s) => prev[s].status === "active") ?? STAGE_ORDER[0]!;
          return { ...prev, [active]: { stage: active, status: "error", message } };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [screen, batchIndex]);

  useInput(
    (char) => {
      if (screen !== "summary" || kdenliveStatus !== "idle" || !result) return;
      if (char.toLowerCase() === "y") {
        openInKdenlive(result.projectPath);
      } else if (char.toLowerCase() === "n") {
        setKdenliveStatus("opened");
        instance.unmount();
        process.exit(0);
      }
    },
    { isActive: screen === "summary" },
  );

  useEffect(() => {
    if (screen !== "history") return;
    let cancelled = false;
    setHistory(null);
    setHistoryError(null);
    listMatchStatuses()
      .then((entries) => {
        if (cancelled) return;
        setHistory(entries);
        setHistoryIndex(0);
      })
      .catch((err) => {
        if (cancelled) return;
        setHistoryError((err as Error).message);
        setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [screen]);

  // Ink puts the terminal in raw mode whenever an input handler is mounted, and raw mode
  // delivers Ctrl+C as the byte \x03 rather than raising SIGINT — so the process-level SIGINT
  // handler below never fires on any screen with a field or key handler. Handle it here, and
  // abort the pipeline on the way out so yt-dlp/ffmpeg/Chrome children go down with us instead
  // of being orphaned mid-render.
  useInput((char, key) => {
    if (key.ctrl && char === "c") quit(130);
  });

  // Tab, not a letter: ink-text-input passes Tab through untouched, so it can't collide with
  // typing a match URL into the field below.
  useInput(
    (_char, key) => {
      if (key.tab) setScreen("history");
    },
    { isActive: screen === "input" },
  );

  useInput(
    (_char, key) => {
      if (key.tab) setScreen("history");
      else if (key.escape) {
        instance.unmount();
        process.exit(batchResults.some((r) => r.error !== null) ? 1 : 0);
      }
    },
    { isActive: screen === "batchSummary" },
  );

  useInput(
    (char, key) => {
      if (key.escape || char.toLowerCase() === "b") {
        setScreen("input");
        return;
      }
      if (!history || history.length === 0) return;
      if (key.upArrow || char === "k") {
        setHistoryIndex((i) => (i - 1 + history.length) % history.length);
      } else if (key.downArrow || char === "j") {
        setHistoryIndex((i) => (i + 1) % history.length);
      } else if (key.return) {
        const entry = history[historyIndex];
        if (!entry) return;
        if (entry.projectPath) {
          openInKdenlive(entry.projectPath);
        } else {
          // Incomplete: re-run the pipeline for it. Every stage skip-reuses its cached file,
          // so resuming needs no special handling beyond pointing runPipeline at the id.
          setInput(String(entry.matchId));
          setStages(initialStages());
          setRunError(null);
          setScreen("progress");
        }
      }
    },
    { isActive: screen === "history" },
  );

  if (screen === "input") {
    return (
      <Box flexDirection="column">
        <Header />
        <Box>
          <Text color={COLORS.gold}>Match URL, ID, or list file </Text>
          <Text color={COLORS.muted}>❯ </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} placeholder="12247403" />
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.muted}>Tab — recent matches · Ctrl+C — quit</Text>
        </Box>
        {inputError && (
          <Box marginTop={1}>
            <Text color={COLORS.crimson}>{inputError}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (screen === "batchSummary") {
    const okCount = batchResults.filter((r) => r.error === null).length;
    return (
      <Box flexDirection="column">
        <Header />
        <Box borderStyle="round" borderColor={okCount === batchResults.length ? COLORS.lead : COLORS.gold} paddingX={2} flexDirection="column">
          <Text color={okCount === batchResults.length ? COLORS.lead : COLORS.gold} bold>
            {okCount} ok / {batchResults.length - okCount} failed
          </Text>
          {batchResults.map((r) => (
            <Box key={r.entry}>
              <Text color={r.error === null ? COLORS.lead : COLORS.crimson}>
                {r.error === null ? "✓" : "✗"}{" "}
              </Text>
              <Text color={COLORS.quartz}>{r.entry}</Text>
              <Text color={COLORS.muted}> {r.error ?? r.projectPath}</Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.muted}>Tab — browse results in history · Esc quit</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "history") {
    return (
      <Box flexDirection="column">
        <Header />
        {history === null ? (
          <Text color={COLORS.muted}>Loading recent matches…</Text>
        ) : history.length === 0 ? (
          <Text color={COLORS.muted}>No matches downloaded yet.</Text>
        ) : (
          <Box flexDirection="column">
            {history.map((entry, i) => (
              <Box key={entry.matchId}>
                <Text color={COLORS.gold}>{i === historyIndex ? "❯ " : "  "}</Text>
                <Text color={i === historyIndex ? COLORS.quartz : COLORS.muted}>
                  {entry.matchId} {entry.leftNickname} vs {entry.rightNickname}
                </Text>
                <Text> </Text>
                {STAGE_ORDER.map((stage) => (
                  <Text key={stage} color={entry.stages[stage] ? COLORS.lead : COLORS.panelEdgeLight}>
                    {entry.stages[stage] ? "✓" : "·"}
                  </Text>
                ))}
                <Text color={entry.projectPath ? COLORS.lead : COLORS.muted}>
                  {entry.projectPath ? " ready" : " incomplete"}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {historyError && (
          <Box marginTop={1}>
            <Text color={COLORS.crimson}>{historyError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={COLORS.muted}>↑/↓ select · Enter open/resume · Esc back</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "progress") {
    return (
      <Box flexDirection="column">
        <Header />
        {batchEntries && (
          <Box marginBottom={1}>
            <Text color={COLORS.gold}>
              Match {batchIndex + 1}/{batchEntries.length}
            </Text>
            <Text color={COLORS.muted}> · {batchEntries[batchIndex]}</Text>
          </Box>
        )}
        <Box flexDirection="column" gap={0}>
          {STAGE_ORDER.map((stage) => (
            <StageRow key={stage} event={stages[stage]} />
          ))}
        </Box>
        {runError && (
          <Box marginTop={1} flexDirection="column">
            <Text color={COLORS.crimson} bold>
              Pipeline failed: {runError}
            </Text>
            <Text color={COLORS.muted}>
              Debug a single phase with e.g. `npm run validate-sync -- {input.trim()}`.
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // summary
  const fetchMsg = stages.fetch.message;
  const syncMsg = stages.sync.message;
  return (
    <Box flexDirection="column">
      <Header />
      <Box borderStyle="round" borderColor={COLORS.lead} paddingX={2} flexDirection="column">
        <Text color={COLORS.lead} bold>
          ✓ Done
        </Text>
        {fetchMsg && <Text color={COLORS.quartz}>{fetchMsg}</Text>}
        {syncMsg && <Text color={COLORS.muted}>sync: {syncMsg}</Text>}
        <Text color={COLORS.muted}>{result?.projectPath}</Text>
        <Text color={COLORS.muted}>{result?.thumbnailPath}</Text>
        <Text color={COLORS.muted}>{result?.chaptersPath}</Text>
        <Text color={COLORS.muted}>{result?.descriptionPath}</Text>
      </Box>
      <Box marginTop={1}>
        {kdenliveStatus === "idle" && <Text color={COLORS.gold}>Open in Kdenlive? (y/n)</Text>}
        {kdenliveStatus === "opening" && <Text color={COLORS.warped}>Launching kdenlive...</Text>}
        {kdenliveStatus === "opened" && <Text color={COLORS.muted}>{result?.projectPath}</Text>}
        {kdenliveStatus === "error" && <Text color={COLORS.crimson}>{kdenliveError}</Text>}
      </Box>
    </Box>
  );
}

const ac = new AbortController();

/**
 * Single shutdown path, shared by the in-app Ctrl+C handler (raw mode) and SIGINT (raw mode off,
 * or `kill -INT`). Hoisted, so App can call it even though `ac`/`instance` are defined below —
 * the body only runs once both exist.
 */
function quit(code: number): void {
  ac.abort();
  instance.unmount();
  if (code !== 0) console.error("\nAborted.");
  process.exit(code);
}

const instance = render(<App signal={ac.signal} />, { exitOnCtrlC: false });

process.on("SIGINT", () => quit(130));

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import React, { useEffect, useState } from "react";
import { Box, render, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  runPipeline,
  STAGE_ORDER,
  type PipelineResult,
  type StageEvent,
  type StageId,
} from "./pipeline.js";
import { listMatchStatuses, type MatchStatusEntry } from "./matchStatus.js";
import { readBatchList } from "./batchList.js";
import { formatMetrics } from "./matchScore.js";
import { dismissSuggestion, getSuggestions, type Suggestion } from "./suggest.js";
import { COLORS, Header, StageRow, SuggestionRow } from "./tuiComponents.js";

function initialStages(): Record<StageId, StageEvent> {
  const entries = STAGE_ORDER.map((stage) => [stage, { stage, status: "pending" as const }] as const);
  return Object.fromEntries(entries) as Record<StageId, StageEvent>;
}

type Screen = "input" | "progress" | "summary" | "history" | "batchSummary" | "suggestions" | "suggestDetail";

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
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // Non-fatal degradation (no Twitch credentials, Twitch API down) worth surfacing.
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [suggestScanned, setSuggestScanned] = useState(0);
  // Bumped by the refresh key to force a rescan past the cache TTL.
  const [suggestNonce, setSuggestNonce] = useState(0);

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

  // Suggestions load on mount, not on entering the screen, so the scan (a few seconds of
  // paging the match feed) overlaps with the operator reading the prompt. Deliberately
  // not gated on `screen`: typing a match ID stays instant either way.
  useEffect(() => {
    let cancelled = false;
    setSuggestions(null);
    setSuggestError(null);
    setSuggestScanned(0);
    getSuggestions({
      signal,
      force: suggestNonce > 0,
      onProgress: (scanned) => {
        if (!cancelled) setSuggestScanned(scanned);
      },
    })
      .then((result) => {
        if (cancelled) return;
        setSuggestions(result.suggestions);
        setSuggestNote(result.note);
        setSuggestIndex(0);
      })
      .catch((err) => {
        if (cancelled) return;
        setSuggestError((err as Error).message);
        setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [suggestNonce]);

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
  // Shift+Tab for suggestions, plain Tab for history. Both are non-letters, so neither
  // collides with typing a match URL into the field.
  useInput(
    (_char, key) => {
      if (key.tab && key.shift) setScreen("suggestions");
      else if (key.tab) setScreen("history");
    },
    { isActive: screen === "input" },
  );

  useInput(
    (char, key) => {
      if (key.escape || char.toLowerCase() === "b") {
        setScreen("input");
        return;
      }
      if (char.toLowerCase() === "r") {
        setSuggestNonce((n) => n + 1);
        return;
      }
      const list = suggestions ?? [];
      if (list.length === 0) return;
      if (key.upArrow || char === "k") {
        setSuggestIndex((i) => (i - 1 + list.length) % list.length);
      } else if (key.downArrow || char === "j") {
        setSuggestIndex((i) => (i + 1) % list.length);
      } else if (char.toLowerCase() === "d") {
        const entry = list[suggestIndex];
        if (!entry) return;
        dismissSuggestion(entry.metrics.matchId);
        const remaining = list.filter((s) => s.metrics.matchId !== entry.metrics.matchId);
        setSuggestions(remaining);
        setSuggestIndex((i) => Math.max(0, Math.min(i, remaining.length - 1)));
      } else if (key.return) {
        setScreen("suggestDetail");
      }
    },
    { isActive: screen === "suggestions" },
  );

  useInput(
    (char, key) => {
      if (key.escape || char.toLowerCase() === "n") {
        setScreen("suggestions");
        return;
      }
      if (char.toLowerCase() !== "y") return;
      const entry = (suggestions ?? [])[suggestIndex];
      if (!entry) return;
      // Same hand-off the history screen uses: point the pipeline at the id and let the
      // existing progress screen drive it.
      setBatchEntries(null);
      setInput(String(entry.metrics.matchId));
      setStages(initialStages());
      setRunError(null);
      setScreen("progress");
    },
    { isActive: screen === "suggestDetail" },
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
          <Text color={COLORS.muted}>Tab — recent matches · </Text>
          {suggestions === null ? (
            <Text color={COLORS.muted}>
              finding matches…{suggestScanned > 0 ? ` (${suggestScanned} scanned)` : ""}
            </Text>
          ) : (
            <Text color={suggestions.length > 0 ? COLORS.warped : COLORS.muted}>
              Shift+Tab — {suggestions.length} suggestions
            </Text>
          )}
          <Text color={COLORS.muted}> · Ctrl+C — quit</Text>
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

  if (screen === "suggestions") {
    return (
      <Box flexDirection="column">
        <Header />
        {suggestions === null ? (
          <Text color={COLORS.muted}>
            Scanning the match feed…{suggestScanned > 0 ? ` ${suggestScanned} matches checked` : ""}
          </Text>
        ) : suggestions.length === 0 ? (
          <Text color={COLORS.muted}>
            No suggestions. Only ranked matches where both players have a Twitch VOD
            qualify — press r to rescan.
          </Text>
        ) : (
          <Box flexDirection="column">
            {suggestions.map((suggestion, i) => (
              <SuggestionRow
                key={suggestion.metrics.matchId}
                suggestion={suggestion}
                selected={i === suggestIndex}
              />
            ))}
          </Box>
        )}
        {suggestError && (
          <Box marginTop={1}>
            <Text color={COLORS.crimson}>{suggestError}</Text>
          </Box>
        )}
        {suggestNote && (
          <Box marginTop={1}>
            <Text color={COLORS.gold}>{suggestNote}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={COLORS.muted}>
            ↑/↓ select · Enter details · d dismiss · r rescan · Esc back
          </Text>
        </Box>
      </Box>
    );
  }

  if (screen === "suggestDetail") {
    const entry = (suggestions ?? [])[suggestIndex];
    if (!entry) {
      return (
        <Box flexDirection="column">
          <Header />
          <Text color={COLORS.muted}>Nothing selected. Esc to go back.</Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Header />
        <Box
          borderStyle="round"
          borderColor={entry.bucket === "close" ? COLORS.lead : COLORS.gold}
          paddingX={2}
          flexDirection="column"
        >
          {/* Same renderer as `npm run score`, so the two never drift apart. */}
          {formatMetrics(entry.metrics)
            .split("\n")
            .map((line, i) => (
              <Text key={i} color={COLORS.quartz}>
                {line}
              </Text>
            ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={COLORS.muted}>
            {entry.bucket === "close" ? "Close race" : "Chaotic run"} · score{" "}
            {entry.score.toFixed(2)} · popularity {entry.popularity.toFixed(1)}
          </Text>
          {entry.vodUrls.map((url) => (
            <Text key={url} color={COLORS.muted}>
              {url}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.gold}>Render this match? (y/n)</Text>
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
        <Text color={COLORS.muted}>{result?.titlePath}</Text>
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

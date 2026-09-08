import type { FC } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import "./overlay.css";
import type { ChatPanelProps } from "./types.js";
import {
  CHAT_FONT_SIZE,
  CHAT_HANGING_INDENT,
  CHAT_HEADER_HEIGHT,
  CHAT_LINE_HEIGHT,
  CHAT_PAD,
  chatCharsPerLine,
  chatMaxLines,
  visibleMessages,
} from "./chatPanelLayout.js";

/**
 * One player's Twitch chat, replayed beside the splits — a prototype of the panel MCSR Matches
 * runs and we do not.
 *
 * The only thing that happens here is a line arriving, so nothing animates: no scroll tween, no
 * fade. Chat is furniture the eye checks between splits, and a panel that slides on every message
 * pulls attention off the run — which is the opposite of why it is on screen.
 *
 * Everything about the wrap and the cap is decided in chatPanelLayout.ts and rendered as given:
 * the lines are emitted pre-broken so the browser never re-wraps them, which is what keeps the
 * panel's height exact instead of "usually about right".
 */
export const ChatPanel: FC<ChatPanelProps> = ({ nickname, messages, widthPx, heightPx, leadInSec, fps }) => {
  // Match start is at leadInSec on the video's clock, and atSec is measured from match start.
  const nowSec = useCurrentFrame() / fps - leadInSec;
  const rows = visibleMessages(messages, nowSec, chatMaxLines(heightPx), chatCharsPerLine(widthPx));

  return (
    <AbsoluteFill
      className="chat-panel"
      style={{ width: widthPx, height: heightPx, padding: CHAT_PAD, fontSize: CHAT_FONT_SIZE }}
    >
      <div className="chat-header" style={{ height: CHAT_HEADER_HEIGHT }}>
        {nickname}
        <span className="chat-header-tag">CHAT</span>
      </div>
      {/* Bottom-aligned: chat grows upward off the newest line, so the panel reads the same
          whether four messages are in it or thirteen. */}
      <div className="chat-feed" style={{ lineHeight: `${CHAT_LINE_HEIGHT}px` }}>
        {rows.map((row, i) => (
          <div
            className="chat-line"
            key={`${i}-${row.name}`}
            /* Hanging indent: the name starts at the margin, every wrapped line under it is
               inset. text-indent only moves the first formatted line, which is exactly the one
               the padding has to be pulled back off. */
            style={{ paddingLeft: CHAT_HANGING_INDENT, textIndent: -CHAT_HANGING_INDENT }}
          >
            <span className="chat-name" style={{ color: row.color }}>
              {row.name}:{" "}
            </span>
            {row.lines.join("\n")}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

import { Composition } from "remotion";
import { Overlay, OverlayTop, OverlayBottom, OverlaySplits, OverlayTimer, OverlayIntro } from "./Overlay.js";
import { Thumbnail } from "./Thumbnail.js";
import { Short, ShortHook } from "./Short.js";
import { ChatPanel } from "./ChatPanel.js";
import {
  BOTTOM_BAND_HEIGHT,
  INTRO_SECONDS,
  RTA_COL_WIDTH,
  SHORT_HEIGHT,
  SHORT_WIDTH,
  STATIC_COL_WIDTH,
  TOP_BAND_HEIGHT,
} from "./layout.js";
import type { ChatPanelProps, OverlayProps, ShortProps, ThumbnailProps } from "./types.js";
import { infumeChat, INFUME_CHAT_NICKNAME } from "./fixtures/chatInfume.js";

const defaultProps: OverlayProps = {
  left: {
    nickname: "edcr",
    countryFlag: "🇬🇧",
    eloRate: 2640,
    eloRank: 1,
    statsScope: "SEASON" as const,
    pbMs: 353371,
    avgMs: 597823,
    gamesPlayed: 5061,
    winRatePct: 64.8,
    forfeitRatePct: 3.2,
    achievements: [
      { id: "wins", level: 10 },
      { id: "playtime", level: 8 },
      { id: "oneshot", level: 1 },
    ],
    avatarUrl: "https://nmsr.nickac.dev/fullbody/8667ba71-b85a-4004-af54-457a9734eed7",
    headUrl: "https://nmsr.nickac.dev/head/8667ba71-b85a-4004-af54-457a9734eed7",
  },
  right: {
    nickname: "Ranik_",
    countryFlag: "🇮🇱",
    eloRate: 2132,
    eloRank: 51,
    statsScope: "SEASON" as const,
    pbMs: 384843,
    avgMs: 668224,
    gamesPlayed: 8895,
    winRatePct: 53.3,
    forfeitRatePct: 5.7,
    achievements: [
      { id: "bestTime", level: 6 },
      { id: "playedMatches", level: 11 },
    ],
    avatarUrl: "https://nmsr.nickac.dev/fullbody/61699b2e-d327-4a01-9f1e-0ea8c3f06bc6",
    headUrl: "https://nmsr.nickac.dev/head/61699b2e-d327-4a01-9f1e-0ea8c3f06bc6",
  },
  matchPlayedLabel: "Aug 8, 2026",
  h2hLeftWins: 6,
  h2hRightWins: 1,
  splits: [
    { label: "Nether Enter", leftMs: 123693, rightMs: 151021 },
    { label: "Bastion", leftMs: 146938, rightMs: 185311 },
    { label: "Fortress", leftMs: 300785, rightMs: 339961 },
    { label: "Blind", leftMs: 368909, rightMs: 434648 },
    { label: "End Enter", leftMs: 458164, rightMs: null },
  ],
  timerStartFrame: 0,
  runResultMs: 505356,
  seedType: "DESERT_TEMPLE",
  bastionType: "STABLES",
  durationInFrames: 21450,
  fps: 30,
};

const thumbnailDefaultProps: ThumbnailProps = {
  left: {
    nickname: "edcr",
    eloRate: 2700,
    // Hardcoded NMSR URLs, the same host the pipeline renders from.
    avatarUrl: "https://nmsr.nickac.dev/fullbody/635f35ee69ed4f0c94ff26ece4818956",
  },
  right: {
    nickname: "Ranik_",
    eloRate: 2158,
    avatarUrl: "https://nmsr.nickac.dev/fullbody/5ee577fdc1af45d3a6fb3e086cc293fb",
  },
  headerLabel: "Minecraft · Speedrunning · Ranked",
};

const shortDefaultProps: ShortProps = {
  top: { nickname: "edcr", eloRate: 2640, eloRank: 1 },
  bottom: { nickname: "Ranik_", eloRate: 2132, eloRank: 51 },
  hook: "both blind at the same time",
  timerStartMs: 402_000,
  durationInFrames: 900,
  fps: 30,
};

/* A real 532-second chat replay, so the Studio and `npm run still` show the panel under the
   traffic it actually has to hold rather than three invented lines. */
const chatDefaultProps: ChatPanelProps = {
  nickname: INFUME_CHAT_NICKNAME,
  messages: infumeChat,
  widthPx: RTA_COL_WIDTH,
  heightPx: BOTTOM_BAND_HEIGHT,
  leadInSec: 10,
  fps: 30,
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MatchOverlay"
        component={Overlay}
        durationInFrames={42900}
        fps={60}
        width={1920}
        height={1080}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames,
          fps: props.fps,
        })}
      />
      <Composition
        id="OverlayTop"
        component={OverlayTop}
        durationInFrames={1}
        fps={30}
        width={1920}
        height={TOP_BAND_HEIGHT}
        defaultProps={defaultProps}
      />
      <Composition
        id="OverlayBottom"
        component={OverlayBottom}
        durationInFrames={21450}
        fps={30}
        width={1920}
        height={BOTTOM_BAND_HEIGHT}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames,
          fps: props.fps,
        })}
      />
      {/* The two halves the pipeline actually renders. Together they tile OverlayBottom exactly:
          OverlaySplits is stepped through its handful of distinct states as stills, OverlayTimer
          is the only composition rendered per frame. */}
      <Composition
        id="OverlaySplits"
        component={OverlaySplits}
        durationInFrames={21450}
        fps={30}
        width={STATIC_COL_WIDTH}
        height={BOTTOM_BAND_HEIGHT}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames,
          fps: props.fps,
        })}
      />
      <Composition
        id="OverlayTimer"
        component={OverlayTimer}
        durationInFrames={21450}
        fps={30}
        width={RTA_COL_WIDTH}
        height={BOTTOM_BAND_HEIGHT}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames,
          fps: props.fps,
        })}
      />
      <Composition
        id="OverlayIntro"
        component={OverlayIntro}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.round(props.fps * INTRO_SECONDS),
          fps: props.fps,
        })}
      />
      {/* Both are stills: nothing on the Shorts board animates. The hook is separate only so
          ffmpeg can fade it out without the board going with it. */}
      <Composition
        id="Short"
        component={Short}
        durationInFrames={1}
        fps={30}
        width={SHORT_WIDTH}
        height={SHORT_HEIGHT}
        defaultProps={shortDefaultProps}
      />
      <Composition
        id="ShortHook"
        component={ShortHook}
        durationInFrames={1}
        fps={30}
        width={SHORT_WIDTH}
        height={SHORT_HEIGHT}
        defaultProps={shortDefaultProps}
      />
      {/* Prototype: not placed in the layout yet, and nothing in the pipeline renders it. Sized
          from its own props so the operator can try it at widths other than the timer strip's. */}
      <Composition
        id="ChatPanel"
        component={ChatPanel}
        durationInFrames={18000}
        fps={30}
        width={RTA_COL_WIDTH}
        height={BOTTOM_BAND_HEIGHT}
        defaultProps={chatDefaultProps}
        calculateMetadata={({ props }) => ({
          fps: props.fps,
          width: props.widthPx,
          height: props.heightPx,
        })}
      />
      <Composition
        id="Thumbnail"
        component={Thumbnail}
        durationInFrames={1}
        fps={1}
        width={1280}
        height={720}
        defaultProps={thumbnailDefaultProps}
      />
    </>
  );
};

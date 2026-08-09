import { Composition } from "remotion";
import {
  Overlay,
  OverlayTop,
  OverlayBottom,
  OverlayIntro,
  TOP_BAND_HEIGHT,
  BOTTOM_BAND_HEIGHT,
} from "./Overlay.js";
import { INTRO_SECONDS } from "./Intro.js";
import { Thumbnail } from "./Thumbnail.js";
import type { OverlayProps, ThumbnailProps } from "./types.js";

const defaultProps: OverlayProps = {
  left: {
    nickname: "edcr",
    countryFlag: "🇬🇧",
    eloRate: 2640,
    eloRank: 1,
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
    // Studio-preview defaults use NMSR, not Starlight Skins: the pose renderer is a small free
    // service that 502s periodically, and unlike the pipeline (resolveAvatarUrl probes and falls
    // back) hardcoded props have no fallback — a preview shouldn't break on someone else's uptime.
    avatarUrl: "https://nmsr.nickac.dev/fullbody/635f35ee69ed4f0c94ff26ece4818956",
  },
  right: {
    nickname: "Ranik_",
    eloRate: 2158,
    avatarUrl: "https://nmsr.nickac.dev/fullbody/5ee577fdc1af45d3a6fb3e086cc293fb",
  },
  headerLabel: "Minecraft · Speedrunning · Ranked",
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

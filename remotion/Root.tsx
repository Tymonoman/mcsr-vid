import { Composition } from "remotion";
import { Overlay } from "./Overlay.js";
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
    avatarUrl: "https://nmsr.nickac.dev/fullbody/8667ba71-b85a-4004-af54-457a9734eed7",
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
    avatarUrl: "https://nmsr.nickac.dev/fullbody/61699b2e-d327-4a01-9f1e-0ea8c3f06bc6",
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
  durationInFrames: 42900,
};

const thumbnailDefaultProps: ThumbnailProps = {
  left: {
    nickname: "edcr",
    eloRate: 2700,
    avatarUrl: "https://starlightskins.lunareclipse.studio/render/walking/635f35ee69ed4f0c94ff26ece4818956/full",
  },
  right: {
    nickname: "Ranik_",
    eloRate: 2158,
    avatarUrl: "https://starlightskins.lunareclipse.studio/render/crossed/5ee577fdc1af45d3a6fb3e086cc293fb/full",
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
        calculateMetadata={({ props }) => ({ durationInFrames: props.durationInFrames })}
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

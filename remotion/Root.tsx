import { Composition } from "remotion";
import { Overlay } from "./Overlay.js";
import type { OverlayProps } from "./types.js";

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
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="MatchOverlay"
      component={Overlay}
      durationInFrames={42900}
      fps={60}
      width={1920}
      height={1080}
      defaultProps={defaultProps}
    />
  );
};

import type { FC } from "react";
import { AbsoluteFill, Img } from "remotion";
import "./overlay.css";
import type { ThumbnailProps, ThumbnailPlayer } from "./types.js";

function PlayerRender({ player, side }: { player: ThumbnailPlayer; side: "left" | "right" }) {
  return (
    <div className={`thumb-player ${side}`}>
      <Img src={player.avatarUrl} />
    </div>
  );
}

function PlayerTag({ player, side }: { player: ThumbnailPlayer; side: "left" | "right" }) {
  return (
    <div className={`thumb-tag ${side}`}>
      <span className="elo">[{player.eloRate}]</span>
      <span className="nick">{player.nickname}</span>
    </div>
  );
}

export const Thumbnail: FC<ThumbnailProps> = (props) => {
  return (
    <AbsoluteFill className="thumb">
      <div className="thumb-header">
        <span className="label">{props.headerLabel}</span>
      </div>
      <div className="thumb-body">
        <PlayerRender player={props.left} side="left" />
        <PlayerRender player={props.right} side="right" />
        <div className="thumb-vs">
          <div className="badge">
            <svg viewBox="0 0 100 100">
              <polygon points="50,4 96,50 50,96" fill="#e2483f" />
              <polygon points="50,4 4,50 50,96" fill="#35d6c4" />
              <rect x="46" y="0" width="8" height="100" fill="#0d0c10" />
            </svg>
          </div>
          <span className="vs-text">1v1</span>
        </div>
        <PlayerTag player={props.left} side="left" />
        <PlayerTag player={props.right} side="right" />
        {props.resultLabel !== null && <div className="thumb-result">{props.resultLabel}</div>}
      </div>
    </AbsoluteFill>
  );
};

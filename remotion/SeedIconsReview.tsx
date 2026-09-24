import React from "react";
import { SeedIcon } from "./SeedIcon.js";

export const SeedIconsReview: React.FC<{ small?: boolean }> = ({ small }) => {
  const types = ["VILLAGE", "SHIPWRECK", "DESERT_TEMPLE", "RUINED_PORTAL", "BURIED_TREASURE"];
  const size = small ? 64 : 160;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        backgroundColor: "#221f27", // --panel
        width: "100%",
        height: "100%",
        padding: 40,
      }}
    >
      {types.map((t) => (
        <SeedIcon key={t} type={t} size={size} />
      ))}
    </div>
  );
};

/**
 * What is writing into a match's directory right now, in words, or null. Delete refuses on it, and
 * so do the thumbnail re-render (the bulk skips on it), a new tile's Use this and the swap on YouTube.
 */
import { allArchiveStates } from "./archive.js";
import { exportRunning } from "./exportRoutes.js";
import { getJob } from "./jobs.js";
import { pickActivity } from "./shortFlow.js";
import { shortRunning } from "./shortsRoutes.js";
import { thumbnailRunning } from "../thumbnails/rerender.js";
import { uploadRunning } from "../youtube/youtubeUpload.js";
import { videoWriting } from "../youtube/youtubeStore.js";

export function busyIn(matchId: number): string | null {
  return getJob(matchId)?.done === false
    ? "a pipeline run"
    : exportRunning(matchId)
      ? "an export"
      : shortRunning(matchId)
        ? "a Short render"
        : pickActivity(matchId) === "running"
          ? "the model's pick (it writes the proxy there)"
          : uploadRunning(matchId)
            ? "an upload"
            : thumbnailRunning(matchId)
              ? "a thumbnail re-render or Use this"
              : videoWriting(matchId)
                ? "a Finish or Put on YouTube"
                : allArchiveStates().some((a) => a.matchId === matchId && a.running)
                  ? "an archive copy"
                  : null;
}

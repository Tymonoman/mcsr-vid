import { randomUUID } from "node:crypto";

export interface KdenliveClipInput {
  /** Path to the media file, as Kdenlive should reference it (absolute, for portability). */
  path: string;
  /** Usable duration of the clip file, in seconds, from its own start. */
  durationSec: number;
  /** Seconds into this clip where the true match-start moment falls. */
  matchOffsetIntoClipSec: number;
  clipName: string;
}

export interface KdenliveMarkerInput {
  /** Absolute timeline position, in seconds from the start of the whole sequence. */
  positionSec: number;
  comment: string;
}

export interface KdenliveProjectInput {
  fps: number;
  width: number;
  height: number;
  leftClip: KdenliveClipInput;
  rightClip: KdenliveClipInput;
  overlayClip: KdenliveClipInput;
  projectName: string;
  markers?: KdenliveMarkerInput[];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function secondsToTimecode(sec: number): string {
  const clamped = Math.max(0, sec);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

interface TrackXml {
  chainXml: string;
  playlistAXml: string;
  playlistBXml: string;
  tractorXml: string;
  tractorId: string;
}

/** Builds one timeline track (audio or video) as a chain + a 2-playlist tractor pair. */
function buildTrack(opts: {
  chainId: string;
  binId: string;
  clip: KdenliveClipInput;
  startOnTimelineSec: number;
  kind: "audio" | "video";
  playlistIdA: string;
  playlistIdB: string;
  tractorId: string;
  positionRect?: string; // "x y w h opacity", video tracks only
}): TrackXml {
  const {
    chainId,
    binId,
    clip,
    startOnTimelineSec,
    kind,
    playlistIdA,
    playlistIdB,
    tractorId,
    positionRect,
  } = opts;

  const durationTc = secondsToTimecode(clip.durationSec);
  const chainXml = `
    <chain id="${chainId}" out="${durationTc}">
        <property name="length">${durationTc}</property>
        <property name="resource">${escapeXml(clip.path)}</property>
        <property name="mlt_service">avformat</property>
        <property name="kdenlive:clipname">${escapeXml(clip.clipName)}</property>
        <property name="kdenlive:id">${binId}</property>
        <property name="kdenlive:folderid">-1</property>
    </chain>`;

  const blank =
    startOnTimelineSec > 0
      ? `<blank length="${secondsToTimecode(startOnTimelineSec)}"/>`
      : "";
  const filterXml =
    positionRect !== undefined
      ? `
            <filter id="${chainId}_transform">
                <property name="mlt_service">qtblend</property>
                <property name="kdenlive_id">qtblend</property>
                <property name="rect">${positionRect}</property>
                <property name="compositing">0</property>
                <property name="distort">0</property>
                <property name="rotate_center">1</property>
            </filter>`
      : "";
  const entryXml = `<entry in="00:00:00.000" out="${secondsToTimecode(clip.durationSec)}" producer="${chainId}">${filterXml}
        </entry>`;

  const playlistAXml = `
    <playlist id="${playlistIdA}">
        ${blank}
        ${entryXml}
    </playlist>`;
  const playlistBXml = `
    <playlist id="${playlistIdB}"/>`;

  const hide = kind === "audio" ? "video" : "audio";
  const audioTrackProp =
    kind === "audio" ? `\n        <property name="kdenlive:audio_track">1</property>` : "";
  const tractorXml = `
    <tractor id="${tractorId}">${audioTrackProp}
        <track producer="${playlistIdA}" hide="${hide}"/>
        <track producer="${playlistIdB}" hide="${hide}"/>
    </tractor>`;

  return { chainXml, playlistAXml, playlistBXml, tractorXml, tractorId };
}

/** Generates a complete .kdenlive (MLT XML) project: two split-screen POV clips + an alpha overlay track. */
export function buildKdenliveProject(input: KdenliveProjectInput): string {
  const { fps, width, height, leftClip, rightClip, overlayClip, projectName, markers } = input;
  const sequenceUuid = `{${randomUUID()}}`;

  const maxOffset = Math.max(
    leftClip.matchOffsetIntoClipSec,
    rightClip.matchOffsetIntoClipSec,
    overlayClip.matchOffsetIntoClipSec,
  );

  const audioLeft = buildTrack({
    chainId: "chain_audio_left",
    binId: "0",
    clip: leftClip,
    startOnTimelineSec: maxOffset - leftClip.matchOffsetIntoClipSec,
    kind: "audio",
    playlistIdA: "playlist0",
    playlistIdB: "playlist1",
    tractorId: "tractor_audio_left",
  });
  const audioRight = buildTrack({
    chainId: "chain_audio_right",
    binId: "1",
    clip: rightClip,
    startOnTimelineSec: maxOffset - rightClip.matchOffsetIntoClipSec,
    kind: "audio",
    playlistIdA: "playlist2",
    playlistIdB: "playlist3",
    tractorId: "tractor_audio_right",
  });
  const videoLeft = buildTrack({
    chainId: "chain_video_left",
    binId: "2",
    clip: leftClip,
    startOnTimelineSec: maxOffset - leftClip.matchOffsetIntoClipSec,
    kind: "video",
    playlistIdA: "playlist4",
    playlistIdB: "playlist5",
    tractorId: "tractor_video_left",
    positionRect: `0 0 ${width / 2} ${height} 1`,
  });
  const videoRight = buildTrack({
    chainId: "chain_video_right",
    binId: "3",
    clip: rightClip,
    startOnTimelineSec: maxOffset - rightClip.matchOffsetIntoClipSec,
    kind: "video",
    playlistIdA: "playlist6",
    playlistIdB: "playlist7",
    tractorId: "tractor_video_right",
    positionRect: `${width / 2} 0 ${width / 2} ${height} 1`,
  });
  const videoOverlay = buildTrack({
    chainId: "chain_overlay",
    binId: "4",
    clip: overlayClip,
    startOnTimelineSec: maxOffset - overlayClip.matchOffsetIntoClipSec,
    kind: "video",
    playlistIdA: "playlist8",
    playlistIdB: "playlist9",
    tractorId: "tractor_video_overlay",
  });

  const tracks = [audioLeft, audioRight, videoLeft, videoRight, videoOverlay];
  const totalDurationSec = Math.max(
    maxOffset - leftClip.matchOffsetIntoClipSec + leftClip.durationSec,
    maxOffset - rightClip.matchOffsetIntoClipSec + rightClip.durationSec,
    maxOffset - overlayClip.matchOffsetIntoClipSec + overlayClip.durationSec,
  );
  const totalDurationTc = secondsToTimecode(totalDurationSec);

  const sequenceTransitions = tracks
    .map((t, i) => {
      const bTrack = i + 1; // track 0 is the black background
      const service = t.tractorId.startsWith("tractor_audio") ? "mix" : "qtblend";
      const extraProps =
        service === "mix"
          ? `
        <property name="accepts_blanks">1</property>
        <property name="sum">1</property>`
          : `
        <property name="compositing">0</property>
        <property name="distort">0</property>
        <property name="rotate_center">0</property>`;
      return `
    <transition id="transition${i}">
        <property name="a_track">0</property>
        <property name="b_track">${bTrack}</property>
        <property name="mlt_service">${service}</property>
        <property name="kdenlive_id">${service}</property>
        <property name="internal_added">237</property>
        <property name="always_active">1</property>${extraProps}
    </transition>`;
    })
    .join("");

  // Markers/guides: well-known Kdenlive/MLT convention (pos = frame index, type = category
  // index), NOT confirmed against a live Kdenlive save (no sample project with markers set was
  // available) — verify by opening a generated project in real Kdenlive.
  const guidesXml =
    markers && markers.length > 0
      ? `
        <property name="kdenlive:docproperties.guides">${escapeXml(
          JSON.stringify(
            markers.map((m) => ({
              comment: m.comment,
              pos: Math.round(m.positionSec * fps),
              type: 0,
            })),
          ),
        )}</property>
        <property name="kdenlive:docproperties.guidesCategories">${escapeXml(
          JSON.stringify([{ color: "#3daee9", comment: "Splits", index: 0 }]),
        )}</property>`
      : "";

  const mainBinEntries = [
    `<entry in="00:00:00.000" out="00:00:00.000" producer="${sequenceUuid}"/>`,
    `<entry in="00:00:00.000" out="00:00:00.000" producer="chain_audio_left"/>`,
    `<entry in="00:00:00.000" out="00:00:00.000" producer="chain_audio_right"/>`,
    `<entry in="00:00:00.000" out="00:00:00.000" producer="chain_video_left"/>`,
    `<entry in="00:00:00.000" out="00:00:00.000" producer="chain_video_right"/>`,
    `<entry in="00:00:00.000" out="00:00:00.000" producer="chain_overlay"/>`,
  ].join("\n        ");

  return `<?xml version='1.0' encoding='utf-8'?>
<mlt LC_NUMERIC="en_US.UTF-8" producer="main_bin" version="7.25.0">
    <profile colorspace="709" description="${width}x${height}, ${fps} fps" display_aspect_den="9" display_aspect_num="16" frame_rate_den="1" frame_rate_num="${fps}" height="${height}" progressive="1" sample_aspect_den="1" sample_aspect_num="1" width="${width}"/>
    <producer id="producer0" in="00:00:00.000" out="${totalDurationTc}">
        <property name="length">2147483647</property>
        <property name="eof">continue</property>
        <property name="resource">black</property>
        <property name="aspect_ratio">1</property>
        <property name="mlt_service">color</property>
        <property name="kdenlive:playlistid">black_track</property>
        <property name="mlt_image_format">rgba</property>
        <property name="set.test_audio">0</property>
    </producer>${tracks.map((t) => t.chainXml).join("")}
${tracks.map((t) => `${t.playlistAXml}${t.playlistBXml}${t.tractorXml}`).join("\n")}
    <tractor id="${sequenceUuid}" in="00:00:00.000" out="${totalDurationTc}">
        <property name="kdenlive:uuid">${sequenceUuid}</property>
        <property name="kdenlive:clipname">${escapeXml(projectName)}</property>
        <property name="kdenlive:sequenceproperties.hasAudio">1</property>
        <property name="kdenlive:sequenceproperties.hasVideo">1</property>
        <property name="kdenlive:sequenceproperties.tracksCount">${tracks.length}</property>
        <property name="kdenlive:sequenceproperties.documentuuid">${sequenceUuid}</property>
        <track producer="producer0"/>
        <track producer="${audioLeft.tractorId}"/>
        <track producer="${audioRight.tractorId}"/>
        <track producer="${videoLeft.tractorId}"/>
        <track producer="${videoRight.tractorId}"/>
        <track producer="${videoOverlay.tractorId}"/>${sequenceTransitions}
    </tractor>
    <playlist id="main_bin">
        <property name="kdenlive:docproperties.version">1.1</property>
        <property name="kdenlive:docproperties.profile">${width}x${height}p${fps}</property>
        <property name="kdenlive:docproperties.uuid">${sequenceUuid}</property>
        <property name="kdenlive:docproperties.opensequences">${sequenceUuid}</property>
        <property name="kdenlive:docproperties.activetimeline">${sequenceUuid}</property>${guidesXml}
        <property name="kdenlive:sequenceFolder">2</property>
        <property name="xml_retain">1</property>
        ${mainBinEntries}
    </playlist>
    <tractor id="final_tractor" in="00:00:00.000" out="${totalDurationTc}">
        <property name="kdenlive:projectTractor">1</property>
        <track in="00:00:00.000" out="${totalDurationTc}" producer="${sequenceUuid}"/>
    </tractor>
</mlt>
`;
}

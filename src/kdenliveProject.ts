import { randomUUID } from "node:crypto";
import path from "node:path";
import { THUMP_LEAD_SEC } from "./sync.js";

/**
 * Timeline zero, expressed as seconds before match start: the world-load thump, which is when
 * the 10s ready-countdown appears. Every clip is placed against this, so match start always
 * lands at exactly ANCHOR_SEC and the exported video opens on the countdown.
 */
export const ANCHOR_SEC = THUMP_LEAD_SEC;

export interface KdenliveClipInput {
  /** Absolute path to the media file. Written out relative to `KdenliveProjectInput.root`. */
  path: string;
  /** Usable duration of the clip file, in seconds, from its own start. */
  durationSec: number;
  /** Seconds into this clip where the true match-start moment falls. */
  matchOffsetIntoClipSec: number;
  clipName: string;
  /** "x y w h opacity" — where this clip sits on the canvas. Overlays default to full-frame;
   *  the two POV clips fall back to a naive half-width split (see buildKdenliveProject). */
  positionRect?: string;
  /** A still held for `durationSec`; MLT needs a different producer than for video. */
  isImage?: boolean;
  /**
   * Successive stills sharing ONE track, each held for its own span — used by the splits panel,
   * which only changes on a split's reveal frame and so needs a handful of images rather than
   * a video. `startSec` is measured from the same origin as `matchOffsetIntoClipSec`.
   *
   * When set, `path` and `durationSec` describe the track as a whole and are not themselves
   * placed; the stills are. MLT holds a qimage producer for as long as the entry asks, so this
   * costs no encoding at all — the alternative, baking the stills back into a video, measured
   * 2m14s of ffmpeg per match for a picture that changes nine times.
   */
  stills?: StillSegment[];
}

export interface StillSegment {
  path: string;
  /** Seconds from the clip's own zero at which this still takes over. */
  startSec: number;
  durationSec: number;
}

/**
 * Where one clip sits once the timeline is anchored on the thump.
 *
 * Exported because the Kdenlive project and the direct-ffmpeg export (src/exportFast.ts) must
 * place every clip identically — they are two renderings of one timeline, and the whole point of
 * having both is that they agree. Deriving this twice is how they would stop agreeing.
 */
export interface TimelinePlacement {
  /** Timeline second the clip's first visible frame lands on. Never negative. */
  startOnTimelineSec: number;
  /** Seconds trimmed off the clip's own head. */
  inSec: number;
  /** How long it plays for. */
  lengthSec: number;
}

export function placeOnTimeline(clip: {
  matchOffsetIntoClipSec: number;
  durationSec: number;
  clipName: string;
}): TimelinePlacement {
  const origin = ANCHOR_SEC - clip.matchOffsetIntoClipSec;
  // A clip whose match start sits later than the anchor is pushed further into its own head,
  // not merely un-blanked: MLT cannot express a negative position, and dropping the negative
  // shift instead would slide the clip late by exactly that much — a desync that renders
  // perfectly and that no in-point assertion can see.
  const inSec = Math.max(0, -origin);
  if (inSec >= clip.durationSec) {
    throw new Error(
      `${clip.clipName}: match start is ${clip.matchOffsetIntoClipSec}s into a ` +
        `${clip.durationSec}s clip, so anchoring it at the thump would trim the whole clip away.`,
    );
  }
  return { startOnTimelineSec: Math.max(0, origin), inSec, lengthSec: clip.durationSec - inSec };
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
  /**
   * Directory every clip path is written relative to, emitted as the `<mlt root>` attribute.
   * Normally the match's media dir. This is what makes a project portable: the lab generates
   * it with root=/media/<id>, and the desktop opens the same file after rewriting one
   * attribute — instead of every clip going offline because the paths were absolute.
   */
  root: string;
  leftClip: KdenliveClipInput;
  rightClip: KdenliveClipInput;
  /** Overlay layers, bottom-most first; each may carry its own positionRect. */
  overlayClips: KdenliveClipInput[];
  projectName: string;
  markers?: KdenliveMarkerInput[];
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

/** One producer placed once on a track: which source, where on the timeline, and which part of it. */
interface PlacedEntry {
  producerId: string;
  binId: string;
  path: string;
  clipName: string;
  isImage: boolean;
  /** Length the producer must declare it can serve. */
  sourceLengthSec: number;
  startOnTimelineSec: number;
  /** Seconds trimmed off the source's head. */
  inSec: number;
  /** Source-relative out point. */
  outSec: number;
}

interface TrackXml {
  chainXml: string;
  playlistAXml: string;
  playlistBXml: string;
  tractorXml: string;
  tractorId: string;
  /** Timeline second the last entry on this track ends on — the track's contribution to length. */
  endSec: number;
  /** Every producer this track placed, for the project bin. */
  producerIds: string[];
}

function producerXml(entry: PlacedEntry): string {
  const lengthTc = secondsToTimecode(entry.sourceLengthSec);
  // A still is a `qimage` producer held for the entry's length; video is an avformat chain.
  // Same element shape either way, so everything downstream (playlists, tractors) is common.
  return entry.isImage
    ? `
    <producer id="${entry.producerId}" out="${lengthTc}">
        <property name="length">${lengthTc}</property>
        <property name="eof">continue</property>
        <property name="resource">${escapeXml(entry.path)}</property>
        <property name="ttl">1</property>
        <property name="mlt_service">qimage</property>
        <property name="kdenlive:clipname">${escapeXml(entry.clipName)}</property>
        <property name="kdenlive:id">${entry.binId}</property>
        <property name="kdenlive:folderid">-1</property>
    </producer>`
    : `
    <chain id="${entry.producerId}" out="${lengthTc}">
        <property name="length">${lengthTc}</property>
        <property name="resource">${escapeXml(entry.path)}</property>
        <property name="mlt_service">avformat</property>
        <property name="kdenlive:clipname">${escapeXml(entry.clipName)}</property>
        <property name="kdenlive:id">${entry.binId}</property>
        <property name="kdenlive:folderid">-1</property>
    </chain>`;
}

/**
 * Builds one timeline track (audio or video) as producers + a 2-playlist tractor pair.
 *
 * Entries must be in timeline order; the gap before each is emitted as a `<blank>`, so a track
 * carrying a sequence of stills lays them end to end without any of them needing its own track.
 */
function buildTrack(opts: {
  entries: PlacedEntry[];
  kind: "audio" | "video";
  playlistIdA: string;
  playlistIdB: string;
  tractorId: string;
  positionRect?: string; // "x y w h opacity", video tracks only
}): TrackXml {
  const { entries, kind, playlistIdA, playlistIdB, tractorId, positionRect } = opts;

  const chainXml = entries.map(producerXml).join("");

  let cursorSec = 0;
  const body: string[] = [];
  for (const entry of entries) {
    // Timeline position of the entry's first frame. `inSec` shifts it because MLT places the
    // *trimmed* clip here, so the head we skipped still has to be paid for in blank.
    const startsAt = entry.startOnTimelineSec + entry.inSec;
    const gap = startsAt - cursorSec;
    if (gap > 0) body.push(`<blank length="${secondsToTimecode(gap)}"/>`);
    const filterXml =
      positionRect !== undefined
        ? `
            <filter id="${entry.producerId}_transform">
                <property name="mlt_service">qtblend</property>
                <property name="kdenlive_id">qtblend</property>
                <property name="rect">${positionRect}</property>
                <property name="compositing">0</property>
                <property name="distort">0</property>
                <property name="rotate_center">1</property>
            </filter>`
        : "";
    body.push(
      `<entry in="${secondsToTimecode(entry.inSec)}" out="${secondsToTimecode(entry.outSec)}" producer="${entry.producerId}">${filterXml}
        </entry>`,
    );
    cursorSec = startsAt + (entry.outSec - entry.inSec);
  }

  const playlistAXml = `
    <playlist id="${playlistIdA}">
        ${body.join("\n        ")}
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

  return {
    chainXml,
    playlistAXml,
    playlistBXml,
    tractorXml,
    tractorId,
    endSec: cursorSec,
    producerIds: entries.map((e) => e.producerId),
  };
}

/** Generates a complete .kdenlive (MLT XML) project: two split-screen POV clips + an alpha overlay track. */
export function buildKdenliveProject(input: KdenliveProjectInput): string {
  const { fps, width, height, projectName, markers, root } = input;
  const sequenceUuid = `{${randomUUID()}}`;

  // Relativise once, here, rather than threading `root` down into every emitter: everything
  // below already reads `clip.path` and stays untouched.
  const relativise = (clip: KdenliveClipInput): KdenliveClipInput => ({
    ...clip,
    path: path.relative(root, clip.path),
    ...(clip.stills ? { stills: clip.stills.map((s) => ({ ...s, path: path.relative(root, s.path) })) } : {}),
  });
  const leftClip = relativise(input.leftClip);
  const rightClip = relativise(input.rightClip);
  const overlayClips = input.overlayClips.map(relativise);

  // Timeline zero is the world-load thump — the moment the 10s ready-countdown appears — so
  // match start always lands at exactly ANCHOR_SEC and the intro can be cut against a
  // fixed mark. It used to be max(every clip's matchOffsetIntoClipSec), which is preRollSec
  // (150s) for a POV clip: the exported timeline opened with two and a half minutes of dead
  // pre-match footage, and lining the cut up by hand in Kdenlive was the whole reason this
  // pipeline still needed a human.
  let binCounter = 0;
  const nextBinId = () => String(binCounter++);

  /** Where this clip's own zero sits on the timeline. Negative means its head is off-screen. */
  const timelineOriginOf = (clip: KdenliveClipInput) => ANCHOR_SEC - clip.matchOffsetIntoClipSec;

  /**
   * One video/audio clip placed against the thump. `inSec` skips the head that falls before
   * timeline zero, so a POV clip carrying 150s of sync headroom starts on screen immediately
   * rather than after 140s of black.
   */
  const placeClip = (opts: {
    producerId: string;
    clip: KdenliveClipInput;
    clipName?: string;
  }): PlacedEntry => {
    const { clip } = opts;
    const { inSec } = placeOnTimeline(clip);
    return {
      producerId: opts.producerId,
      binId: nextBinId(),
      path: clip.path,
      clipName: opts.clipName ?? clip.clipName,
      isImage: clip.isImage === true,
      sourceLengthSec: clip.durationSec,
      startOnTimelineSec: timelineOriginOf(clip),
      inSec,
      outSec: clip.durationSec,
    };
  };

  const audioLeft = buildTrack({
    entries: [placeClip({ producerId: "chain_audio_left", clip: leftClip })],
    kind: "audio",
    playlistIdA: "playlist0",
    playlistIdB: "playlist1",
    tractorId: "tractor_audio_left",
  });
  const audioRight = buildTrack({
    entries: [placeClip({ producerId: "chain_audio_right", clip: rightClip })],
    kind: "audio",
    playlistIdA: "playlist2",
    playlistIdB: "playlist3",
    tractorId: "tractor_audio_right",
  });
  const videoLeft = buildTrack({
    entries: [placeClip({ producerId: "chain_video_left", clip: leftClip })],
    kind: "video",
    playlistIdA: "playlist4",
    playlistIdB: "playlist5",
    tractorId: "tractor_video_left",
    positionRect: leftClip.positionRect ?? `0 0 ${width / 2} ${height} 1`,
  });
  const videoRight = buildTrack({
    entries: [placeClip({ producerId: "chain_video_right", clip: rightClip })],
    kind: "video",
    playlistIdA: "playlist6",
    playlistIdB: "playlist7",
    tractorId: "tractor_video_right",
    positionRect: rightClip.positionRect ?? `${width / 2} 0 ${width / 2} ${height} 1`,
  });

  /**
   * A still sequence becomes one qimage producer per segment, laid end to end on a single
   * track. Segments starting before timeline zero are shortened (or dropped) rather than
   * placed at a negative position, which MLT has no way to express.
   */
  const placeStills = (clip: KdenliveClipInput, i: number): PlacedEntry[] => {
    const origin = timelineOriginOf(clip);
    return (clip.stills ?? []).flatMap((still, j) => {
      const startsAt = origin + still.startSec;
      const visibleSec = still.durationSec + Math.min(0, startsAt);
      if (visibleSec <= 0) return [];
      return [
        {
          producerId: `chain_overlay_${i}_${j}`,
          binId: nextBinId(),
          path: still.path,
          clipName: `${clip.clipName} ${j + 1}`,
          isImage: true,
          sourceLengthSec: visibleSec,
          startOnTimelineSec: Math.max(0, startsAt),
          inSec: 0,
          outSec: visibleSec,
        },
      ];
    });
  };

  const overlayTracks = overlayClips.map((clip, i) =>
    buildTrack({
      entries: clip.stills ? placeStills(clip, i) : [placeClip({ producerId: `chain_overlay_${i}`, clip })],
      kind: "video",
      playlistIdA: `playlist${8 + i * 2}`,
      playlistIdB: `playlist${9 + i * 2}`,
      tractorId: `tractor_video_overlay_${i}`,
      positionRect: clip.positionRect,
    }),
  );

  const tracks = [audioLeft, audioRight, videoLeft, videoRight, ...overlayTracks];
  // Whatever ends last. Each track already knows where its final entry finishes, so this no
  // longer has to re-derive placement arithmetic that buildTrack owns.
  const totalDurationSec = Math.max(0, ...tracks.map((t) => t.endSec));
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
  // index). Confirmed to round-trip correctly through a real Kdenlive save — diffed against
  // a hand-edited project's own autosave backups and the guides JSON survived unchanged.
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

  // Every producer on every track, so a still sequence's images each get their own bin entry.
  // Derived from the tracks rather than re-listed by hand: a producer missing here simply does
  // not appear in Kdenlive's Project Bin.
  const mainBinEntries = [
    `<entry in="00:00:00.000" out="00:00:00.000" producer="${sequenceUuid}"/>`,
    ...tracks.flatMap((t) =>
      t.producerIds.map((id) => `<entry in="00:00:00.000" out="00:00:00.000" producer="${id}"/>`),
    ),
  ].join("\n        ");

  return `<?xml version='1.0' encoding='utf-8'?>
<mlt root="${escapeXml(root)}" LC_NUMERIC="en_US.UTF-8" producer="main_bin" version="7.25.0">
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
        ${overlayTracks.map((t) => `<track producer="${t.tractorId}"/>`).join("\n        ")}${sequenceTransitions}
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

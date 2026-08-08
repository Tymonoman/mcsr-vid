import { readFile } from "node:fs/promises";

export interface WavPcm {
  sampleRate: number;
  /** Mono samples, normalized to [-1, 1]. */
  samples: Float32Array;
}

/** Reads a mono 16-bit PCM WAV file (the format ffmpeg produces with `-ac 1 -f wav`). */
export async function readWavMono16(path: string): Promise<WavPcm> {
  const buf = await readFile(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }

  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkBody = offset + 8;

    if (chunkId === "fmt ") {
      channels = buf.readUInt16LE(chunkBody + 2);
      sampleRate = buf.readUInt32LE(chunkBody + 4);
      bitsPerSample = buf.readUInt16LE(chunkBody + 14);
    } else if (chunkId === "data") {
      dataStart = chunkBody;
      dataLength = chunkSize;
    }

    offset = chunkBody + chunkSize + (chunkSize % 2);
  }

  if (dataStart < 0) throw new Error(`${path}: no data chunk found`);
  if (channels !== 1) throw new Error(`${path}: expected mono audio, got ${channels} channels`);
  if (bitsPerSample !== 16) throw new Error(`${path}: expected 16-bit PCM, got ${bitsPerSample}`);

  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  }

  return { sampleRate, samples };
}

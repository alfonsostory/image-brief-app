// The clip's sound track as 16 kHz mono samples, which is what Whisper expects.
//
// Browsers can decode audio files, but Safari's decoder refuses video containers such as the .MOV files phones
// record, and large clips are heavy to decode whole. So MP4/MOV/M4A files are demuxed here with mp4box.js:
// the AAC track is re-wrapped as a raw ADTS stream (which every browser decodes) or PCM is read directly, and only
// the small audio stream goes to the browser's decoder. Anything else (WebM, MP3, WAV…) goes straight to it.
import { createFile, MP4BoxBuffer } from "mp4box";

const RATE = 16000;

export async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  const failures = [];
  if (isIsoBmff(buf)) {
    try {
      return await fromContainer(buf);
    } catch (e) {
      failures.push(`container: ${e.message}`);
    }
  }
  try {
    return await toMono16k(await decodeWithBrowser(buf));
  } catch (e) {
    failures.push(`browser decoder: ${e.message}`);
  }
  throw new Error(failures.join("; "));
}

// MP4-family files start with a box header; the type sits at bytes 4–7
function isIsoBmff(buf) {
  if (buf.byteLength < 12) return false;
  const type = String.fromCharCode(...new Uint8Array(buf, 4, 4));
  return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(type);
}

function decodeWithBrowser(buf) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  return ctx.decodeAudioData(buf).finally(() => ctx.close?.());
}

async function toMono16k(decoded) {
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

// Pulls the first audio track's samples out of an MP4/MOV with mp4box.js. Parsing is synchronous, so the
// callbacks have all fired by the time appendBuffer/flush return.
function extractAudioTrack(buf) {
  const mp4 = createFile(false);
  let error, track, entry;
  const samples = [];
  mp4.onError = (module, message) => { error = new Error(`${module}: ${message}`); };
  mp4.onReady = (info) => {
    // Uncompressed audio entries (sowt, in24, lpcm…) are not classed as audio by mp4box, so also go by the handler
    const isSound = (t) => t.audio || t.type === "audio" || mp4.getTrackById(t.id)?.mdia?.hdlr?.handler === "soun";
    track = (info.audioTracks && info.audioTracks[0]) || (info.tracks || []).find(isSound);
    if (!track) { error = new Error("no audio track in this file"); return; }
    entry = mp4.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
    mp4.setExtractionOptions(track.id, null, { nbSamples: 1e6 });
    mp4.start();
  };
  mp4.onSamples = (id, user, batch) => { for (const s of batch) samples.push(s); };
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, 0), true);
  mp4.flush();
  if (error) throw error;
  if (!track) throw new Error("not a complete MP4/MOV file");
  if (!samples.length) throw new Error("the audio track has no samples");
  return { track, entry, samples };
}

async function fromContainer(buf) {
  const { track, entry, samples } = extractAudioTrack(buf);
  const type = entry.type;
  if (type === "mp4a") return toMono16k(await decodeWithBrowser(toAdts(samples, entry, track)));
  const pcm = pcmLayout(buf, entry);
  if (pcm) return toMono16k(pcmToBuffer(samples, pcm));
  throw new Error(`unsupported audio codec "${track.codec || type}"`);
}

// Layout of an uncompressed track, read from the raw QuickTime sound description (versions 0, 1 and 2) since mp4box
// leaves these entries unparsed. Returns null for anything that is not PCM.
function pcmLayout(buf, entry) {
  const type = entry.type;
  if (!["sowt", "twos", "lpcm", "in24", "in32", "fl32", "fl64", "raw "].includes(type)) return null;
  const v = new DataView(buf, entry.start, entry.size);
  // mp4box may point `start` at the box header or at its payload; the payload begins with 6 reserved bytes and the data reference index
  const fourcc = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
  const h = fourcc === type ? 8 : 0;
  const version = v.getUint16(h + 8);
  let channels, bits, rate, float = false, bigEndian = true;
  if (version === 2) {
    rate = v.getFloat64(h + 32);
    channels = v.getUint32(h + 40);
    bits = v.getUint32(h + 48);
    const flags = v.getUint32(h + 52);
    float = !!(flags & 1);
    bigEndian = !!(flags & 2);
  } else {
    channels = v.getUint16(h + 16);
    bits = v.getUint16(h + 18);
    rate = v.getUint32(h + 24) / 65536;
    if (type === "sowt") bigEndian = false;
    // QuickTime states the byte order of in24/in32/fl32/fl64 data in an 'enda' box inside 'wave' (1 = little-endian)
    const raw = new Uint8Array(buf, entry.start, entry.size);
    for (let i = h; i + 6 <= raw.length; i++) {
      if (raw[i] === 0x65 && raw[i + 1] === 0x6e && raw[i + 2] === 0x64 && raw[i + 3] === 0x61) { bigEndian = (raw[i + 4] * 256 + raw[i + 5]) === 0; break; }
    }
    if (type === "in24") bits = 24;
    if (type === "in32") bits = 32;
    if (type === "fl32") { bits = 32; float = true; }
    if (type === "fl64") { bits = 64; float = true; }
    if (type === "raw ") bits = 8;
  }
  return { channels, bits, rate, float, bigEndian, unsigned: type === "raw " };
}

// Interleaved PCM samples straight into an AudioBuffer
function pcmToBuffer(samples, { channels, bits, rate, float, bigEndian, unsigned }) {
  const bytes = bits / 8;
  if (![1, 2, 3, 4, 8].includes(bytes) || !channels || !rate) throw new Error(`unsupported PCM layout (${bits}-bit, ${channels} ch, ${rate} Hz)`);
  const total = samples.reduce((n, s) => n + s.data.length, 0);
  const frames = Math.floor(total / (bytes * channels));
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const buffer = new Ctx(1, 1, rate).createBuffer(channels, frames, rate);
  const out = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const read = (v, i) => {
    if (float) return bytes === 8 ? v.getFloat64(i, !bigEndian) : v.getFloat32(i, !bigEndian);
    if (bytes === 1) return (unsigned ? v.getUint8(i) - 128 : v.getInt8(i)) / 128;
    if (bytes === 2) return v.getInt16(i, !bigEndian) / 32768;
    if (bytes === 3) {
      const [b0, b1, b2] = bigEndian ? [v.getUint8(i), v.getUint8(i + 1), v.getUint8(i + 2)] : [v.getUint8(i + 2), v.getUint8(i + 1), v.getUint8(i)];
      return (((b0 << 24) | (b1 << 16) | (b2 << 8)) >> 8) / 8388608;
    }
    return v.getInt32(i, !bigEndian) / 2147483648;
  };
  let frame = 0, ch = 0;
  for (const s of samples) {
    const v = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
    for (let i = 0; i + bytes <= s.data.byteLength && frame < frames; i += bytes) {
      out[ch][frame] = read(v, i);
      if (++ch === channels) { ch = 0; frame++; }
    }
  }
  return buffer;
}

// The AudioSpecificConfig bytes from the esds box, which QuickTime files may tuck inside a 'wave' box
function audioSpecificConfig(entry) {
  const esds = entry.esds || entry.esdss?.[0] || entry.wave?.esds || entry.wave?.boxes?.find((b) => b.type === "esds");
  const decoderConfig = esds?.esd?.descs?.find((d) => d.tag === 4);
  return decoderConfig?.descs?.find((d) => d.tag === 5)?.data;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// Wraps each AAC frame in a 7-byte ADTS header, producing a stream any browser's decoder accepts
function toAdts(samples, entry, track) {
  const asc = audioSpecificConfig(entry);
  let objectType = 2, sfi = -1, channels = 0;
  if (asc && asc.length >= 2) {
    objectType = asc[0] >> 3;
    sfi = ((asc[0] & 7) << 1) | (asc[1] >> 7);
    channels = (asc[1] >> 3) & 15;
  }
  if (objectType === 5 || objectType === 29) objectType = 2; // HE-AAC: ADTS carries the LC core, decoders find SBR/PS themselves
  if (objectType < 1 || objectType > 4) throw new Error(`unsupported AAC object type ${objectType}`);
  if (sfi < 0 || sfi > 12) sfi = AAC_RATES.indexOf(entry.samplerate || track.audio?.sample_rate);
  if (sfi < 0) throw new Error("unsupported AAC sample rate");
  if (!channels) channels = entry.channel_count || track.audio?.channel_count || 2;
  const profile = objectType - 1;
  const out = new Uint8Array(samples.reduce((n, s) => n + s.data.length + 7, 0));
  let o = 0;
  for (const s of samples) {
    const len = s.data.length + 7;
    out[o++] = 0xff;
    out[o++] = 0xf1;
    out[o++] = (profile << 6) | (sfi << 2) | (channels >> 2);
    out[o++] = ((channels & 3) << 6) | (len >> 11);
    out[o++] = (len >> 3) & 0xff;
    out[o++] = ((len & 7) << 5) | 0x1f;
    out[o++] = 0xfc;
    out.set(s.data, o);
    o += s.data.length;
  }
  return out.buffer;
}

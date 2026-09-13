// Transcribes 16 kHz mono samples with OpenAI's hosted Whisper (whisper-1), which returns a time for every word.
// The samples are sent as a small 16-bit WAV, so even a large video only uploads its sound track.

const LIMIT = 25e6; // OpenAI's upload cap

export function toWav(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const tag = (offset, s) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

export async function transcribeWithOpenAI(samples, apiKey, onStage = () => {}) {
  const wav = toWav(samples);
  if (wav.size > LIMIT) throw new Error(`OpenAI accepts up to 25 MB of audio, about 13 minutes; this clip is ${(wav.size / 1e6).toFixed(0)} MB. Use Whisper on this device for longer clips.`);
  onStage(`Uploading ${(wav.size / 1e6).toFixed(1)} MB of audio to OpenAI…`);
  const form = new FormData();
  form.append("file", wav, "audio.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  } catch (e) {
    throw new Error(`Couldn't reach OpenAI (${e.message}).`);
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error("OpenAI rejected the API key. Check it under Transcription on the New request screen.");
    let msg = `OpenAI returned ${res.status}.`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  onStage("Waiting for OpenAI's transcript…");
  return wordsFromOpenAI(await res.json());
}

// `words` carry the timings but no punctuation; `segments` carry punctuated phrases. Borrow a segment's punctuation
// when its word count lines up, and mark segment ends so the transcript breaks lines there.
function wordsFromOpenAI({ words = [], segments = [] }) {
  const out = words.map((w) => ({ text: String(w.word).trim(), start: w.start, end: w.end }));
  let p = 0;
  for (const seg of segments) {
    const from = p;
    while (p < out.length && out[p].start < seg.end - 0.01) p++;
    const group = out.slice(from, p);
    if (!group.length) continue;
    const tokens = String(seg.text).trim().split(/\s+/);
    if (tokens.length === group.length) group.forEach((w, i) => { w.text = tokens[i]; });
    group[group.length - 1].break = true;
  }
  return out.filter((w) => w.text);
}

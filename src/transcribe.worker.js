// Runs Whisper in a Web Worker so the page stays responsive. The model loads once (and is cached by the browser),
// then each clip's 16 kHz mono audio comes in and word-level timings go back out.
import { pipeline, WhisperTextStreamer } from "@huggingface/transformers";

// The "timestamped" export returns a start/end per word; base.en is the smallest model that transcribes cleanly.
// The 8-bit decoder of this export does not load in the bundled ONNX runtime, so the decoder is 4-bit: q4f16 (~90 MB in
// total) first, and the larger q4 file as a fallback if a browser cannot run the fp16 variant.
const MODEL = "onnx-community/whisper-base.en_timestamped";
const DTYPES = [
  { encoder_model: "q8", decoder_model_merged: "q4f16" },
  { encoder_model: "q8", decoder_model_merged: "q4" },
];
const post = (msg) => self.postMessage(msg);

const loaded = {};
function loadOne(model, dtype) {
  const key = `${model}|${JSON.stringify(dtype)}`;
  if (!loaded[key]) {
    const files = {}; // loaded/total per file, summed into one download percentage
    loaded[key] = pipeline("automatic-speech-recognition", model, {
      device: "wasm",
      dtype,
      progress_callback: (p) => {
        if (p.status !== "progress" || !p.total) return;
        files[p.file] = [p.loaded, p.total];
        const [loaded, total] = Object.values(files).reduce((a, f) => [a[0] + f[0], a[1] + f[1]], [0, 0]);
        post({ type: "stage", label: "Downloading Whisper (first time only)…", pct: (loaded / total) * 100 });
      },
    });
  }
  return loaded[key];
}
// `model` / `dtype` can be overridden per message (handy for trying other exports); otherwise walk the DTYPES fallbacks
async function load(model = MODEL, dtype) {
  if (dtype) return loadOne(model, dtype);
  let lastError;
  for (const d of DTYPES) {
    try { return await loadOne(model, d); } catch (e) { lastError = e; }
  }
  throw lastError;
}

self.onmessage = async ({ data: { audio, model, dtype } }) => {
  try {
    post({ type: "stage", label: "Loading Whisper…", pct: null });
    const transcriber = await load(model, dtype);
    const seconds = audio.length / 16000;
    let text = "";
    const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
      skip_prompt: true,
      on_chunk_start: (t) => post({ type: "stage", label: "Transcribing with Whisper…", pct: Math.min(99, (t / seconds) * 100) }),
      callback_function: (piece) => { text += piece; post({ type: "partial", text }); },
    });
    post({ type: "stage", label: "Transcribing with Whisper…", pct: 0 });
    const out = await transcriber(audio, { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5, streamer });
    const words = (out.chunks || [])
      .map((c) => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }))
      .filter((w) => w.text);
    post({ type: "done", words, text: out.text });
  } catch (e) {
    post({ type: "error", message: e?.message || String(e) });
  }
};

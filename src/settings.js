// Transcription preferences, kept in this browser only. The OpenAI key never leaves the device except in the
// request to api.openai.com itself.
const KEY = "image-brief-transcription";
const DEFAULTS = { engine: "local", openaiKey: "" }; // engine: "local" (Whisper on this device) | "openai" (Whisper API)

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}

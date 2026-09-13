# Image brief workflow — prototype

Clip → transcript → word-level image brief → editor queue.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:5173 (it should open automatically).

## Notes

- Transcription runs in the browser. `src/transcribe.worker.js` loads Whisper
  (`onnx-community/whisper-base.en_timestamped`, about 90 MB, cached by the
  browser after the first run) through transformers.js and returns a start
  time for every word, so nothing is uploaded and no API key is needed. Lines
  carry `times` (one start per word) and `end`; the demo clip still uses the
  estimated `DEMO_LINES`. The Vite dev and preview servers send COOP/COEP
  headers so the WebAssembly runtime can use threads — set the same headers
  wherever the app is hosted.
- Images and music/SFX attach to a passage the same way: the `+` in the
  panel, or drop files on it. Editing notes (free text for the editor) are
  typed into the panel's notes box. Every upload and note is also saved to
  the client's library (sidebar → Images, Music & SFX, Editing notes) so it
  can be reused on later briefs.
- In the brief editor, clicking a word or timestamp seeks the preview to that
  moment, and the bar under the preview scrubs like a media player. The demo
  clip has no video, so its bar only moves the playhead.
- Passages with notes get a ✎ marker above their first word. Hover it to see
  the notes floating over the transcript, click it to keep them open (× or a
  second click closes), and edit them right there.
- While the clip plays, the transcript follows it: the selection is cleared and
  the word under the playhead is lit gold. Clicking a word pauses the clip and
  selects again.
- Colours and fonts follow the Alfonso Edits agency theme (gold on near-black,
  Inter + Space Grotesk), the same OKLCH tokens as the agency site.
- The library is persisted in IndexedDB (`src/library.js`) and survives a
  refresh. Jobs and the in-progress brief are in memory only; refreshing the
  page clears the queue.

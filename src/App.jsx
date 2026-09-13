import { useState, useRef, useEffect, useMemo } from "react";
import { loadAssets, saveAsset, updateAsset, deleteAsset } from "./library.js";
import { decodeAudio } from "./audio.js";

// Transcript for the demo clip (real clips are transcribed in the browser, see transcribe.worker.js)
const DEMO_LINES = [
  { t: 0.0, text: "Three things I wish someone told me before I started running" },
  { t: 3.6, text: "Number one your shoes matter way more than your playlist" },
  { t: 7.9, text: "Number two the first ten minutes always feel bad and that is normal" },
  { t: 12.4, text: "Number three slow down until you can talk while you run" },
  { t: 16.8, text: "Do that for a month and I promise it gets easier" },
];

// Alfonso Edits agency palette (same OKLCH tokens as the agency site): gold on near-black, cyan and violet as secondary accents
const ACCENT = "oklch(0.82 0.13 85)"; // agency gold
const ON_ACCENT = "oklch(0.12 0.015 260)"; // text on gold
const CYAN = "oklch(0.78 0.14 210)";
const VIOLET = "oklch(0.62 0.19 295)";
const tint = (alpha) => `oklch(0.82 0.13 85 / ${alpha})`; // gold wash
const C = {
  bg: "oklch(0.12 0.015 260)",
  panel: "oklch(0.155 0.015 260)",
  line: "rgba(255,255,255,.1)",
  text: "#fff",
  mute: "rgba(255,255,255,.6)",
  faint: "rgba(255,255,255,.4)",
};

let uid = 1;
const nid = () => `id${uid++}`;
// Library assets outlive a page load, so they need ids that don't restart from 1
const aid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// What each media kind accepts. Images and audio go through the same upload → library → passage flow.
const MEDIA = {
  images: {
    accept: "image/jpeg,image/png,image/webp",
    hint: "JPG, PNG or WebP · up to 15 MB each",
    ok: (f) => /^image\/(jpeg|png|webp)$/.test(f.type) && f.size <= 15e6,
  },
  audio: {
    accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac",
    hint: "MP3, WAV, M4A, AAC, OGG or FLAC · up to 30 MB each",
    ok: (f) => (f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name)) && f.size <= 30e6,
  },
};
const splitFiles = (kind, files) => {
  const ok = [...files].filter(MEDIA[kind].ok);
  return { ok, skipped: files.length - ok.length };
};
// Editing notes are the third thing a passage can carry: free text for the editor, saved to the library like images and audio.
const LABEL = { images: "image", audio: "track", notes: "note" };

// Lines look like { id, t, words, times?, end? }. Demo lines only have a start, so word times are spread evenly across
// the line; transcribed lines carry a real start per word (`times`) and their own `end`.
function parseTranscript(lines) {
  return lines.map((l) => ({ id: nid(), t: l.t, words: l.text.split(/\s+/) }));
}
// Groups Whisper's word timings into caption-sized lines: a new line after a sentence ends, after a pause, or every 12 words
function linesFromWords(words) {
  const lines = [];
  let cur = null;
  let lastStart = 0;
  words.forEach((w, i) => {
    const start = Math.max(w.start, lastStart); // keep timings monotonic even if the model wobbles
    const prev = words[i - 1];
    const pause = prev ? start - prev.end : 0;
    const sentenceEnd = prev && /[.!?]$/.test(prev.text) && cur.words.length >= 4;
    if (!cur || cur.words.length >= 12 || pause > 0.8 || sentenceEnd) {
      cur = { id: nid(), t: start, end: start, words: [], times: [] };
      lines.push(cur);
    }
    cur.words.push(w.text);
    cur.times.push(start);
    cur.end = Math.max(cur.end, w.end, start + 0.2);
    lastStart = start;
  });
  return lines;
}

function fmt(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${sec}`;
}

// When a line stops: its own last word for transcribed lines, otherwise the next line's start
const lineEnd = (lines, li) => lines[li].end ?? (lines[li + 1] ? lines[li + 1].t : lines[li].t + 3.5);
// When word `wi` of line `li` starts (`wi` = words.length asks for the line's end)
function wordTime(lines, li, wi) {
  const line = lines[li];
  if (line.times) return wi < line.words.length ? line.times[wi] : lineEnd(lines, li);
  return line.t + (wi / line.words.length) * (lineEnd(lines, li) - line.t);
}

// Which word the playhead is on, or null when it is outside the transcript
function wordAt(lines, t) {
  let li = -1;
  lines.forEach((l, i) => { if (l.t <= t) li = i; });
  if (li === -1 || t >= lineEnd(lines, li)) return null;
  const line = lines[li];
  if (line.times) {
    let wi = 0;
    line.times.forEach((s, i) => { if (s <= t) wi = i; });
    return { li, wi };
  }
  return { li, wi: Math.min(line.words.length - 1, Math.floor(((t - line.t) / (lineEnd(lines, li) - line.t)) * line.words.length)) };
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// How many queued jobs reference a library asset
const usedIn = (jobs, kind, assetId) => jobs.filter((j) => j.briefs.some((b) => b[kind].some((x) => x.assetId === assetId))).length;

function useToast() {
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);
  return [toast, setToast];
}
function Toast({ text }) {
  if (!text) return null;
  return <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-3 py-2 rounded-md text-sm" style={{ background: C.panel, border: `1px solid ${C.line}` }}>{text}</div>;
}

// One shared <audio> so only a single track plays at a time, wherever it was started from
const player = typeof Audio === "undefined" ? null : new Audio();
function usePlayer() {
  const [playing, setPlaying] = useState(null); // url of the track currently playing
  useEffect(() => {
    if (!player) return;
    const sync = () => setPlaying(player.paused ? null : player.src);
    const evs = ["play", "pause", "ended"];
    evs.forEach((e) => player.addEventListener(e, sync));
    sync();
    return () => evs.forEach((e) => player.removeEventListener(e, sync));
  }, []);
  const toggle = (url) => {
    if (!player) return;
    if (player.src === url && !player.paused) return player.pause();
    player.src = url;
    player.play().catch(() => {});
  };
  return { playing, toggle };
}
function PlayToggle({ on, onClick, disabled, title }) {
  return (
    <button onClick={onClick} disabled={disabled} className="w-6 h-6 shrink-0 rounded-full grid place-items-center text-[9px] disabled:opacity-40" style={{ background: on ? ACCENT : C.panel, border: `1px solid ${on ? ACCENT : C.line}`, color: on ? ON_ACCENT : C.text }} title={title || (on ? "Pause" : "Play")}>
      {on ? "❚❚" : "▶"}
    </button>
  );
}
function PlayButton({ url, playing, toggle }) {
  return <PlayToggle on={playing === url} onClick={() => toggle(url)} />;
}
// Media-player style scrub bar: click anywhere on it, or drag the knob, to move the playhead
function ScrubBar({ time, duration, onSeek }) {
  const track = useRef();
  const [drag, setDrag] = useState(null); // fraction under the pointer while dragging, so the knob never lags the pointer
  const scrub = (e) => {
    const r = track.current.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setDrag(f);
    onSeek(f * duration);
  };
  const pct = (drag ?? (duration ? time / duration : 0)) * 100;
  return (
    <div
      ref={track}
      className="flex-1 py-2 cursor-pointer"
      style={{ touchAction: "none" }}
      onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
      onPointerMove={(e) => { if (drag !== null) scrub(e); }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      title="Drag to scrub"
    >
      <div className="relative h-1.5 rounded-full" style={{ background: C.line }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: ACCENT }} />
        <div className="absolute top-1/2 w-3 h-3 rounded-full -translate-x-1/2 -translate-y-1/2" style={{ left: `${pct}%`, background: "#fff", boxShadow: "0 0 0 1px rgba(0,0,0,.4)" }} />
      </div>
    </div>
  );
}
function AudioRow({ item, playing, toggle, onRemove, sub }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5" style={{ background: C.bg, border: `1px solid ${C.line}` }}>
      <PlayButton url={item.url} playing={playing} toggle={toggle} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs">{item.name}</div>
        {sub && <div className="text-[10px]" style={{ color: C.faint }}>{sub}</div>}
      </div>
      {onRemove && <button onClick={onRemove} className="shrink-0 text-sm px-1" style={{ color: C.faint }} title="Remove">×</button>}
    </div>
  );
}

// Note text that turns into a textarea when clicked (only when onChange is given). Enter or clicking away saves, Esc cancels.
function NoteText({ text, onChange, className = "" }) {
  const [editing, setEditing] = useState(false);
  const draft = useRef(text);
  const finish = (save) => {
    setEditing(false);
    const t = draft.current.trim();
    draft.current = text;
    if (save && t && t !== text) onChange(t);
  };
  if (editing) {
    return (
      <textarea
        autoFocus
        defaultValue={text}
        rows={Math.min(6, text.split("\n").length + 1)}
        onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
        onChange={(e) => { draft.current = e.target.value; }}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === "Escape") finish(false);
        }}
        className={`w-full outline-none resize-none rounded-sm ${className}`}
        style={{ background: C.panel, color: C.text, boxShadow: `0 0 0 1px ${ACCENT}` }}
      />
    );
  }
  return (
    <div
      onClick={onChange ? () => { draft.current = text; setEditing(true); } : undefined}
      className={`whitespace-pre-wrap break-words ${onChange ? "cursor-text" : ""} ${className}`}
      title={onChange ? "Click to edit" : undefined}
    >
      {text}
    </div>
  );
}
function NoteRow({ item, onChange, onRemove }) {
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5" style={{ background: C.bg, border: `1px solid ${C.line}` }}>
      <span className="shrink-0 text-xs leading-4" style={{ color: ACCENT }}>✎</span>
      <NoteText text={item.text} onChange={onChange} className="min-w-0 flex-1 text-xs leading-4" />
      {onRemove && <button onClick={onRemove} className="shrink-0 text-sm px-1 -my-0.5" style={{ color: C.faint }} title="Remove">×</button>}
    </div>
  );
}
// Where a new note is typed. Enter adds it, Shift+Enter starts a new line.
function NoteComposer({ onAdd, placeholder }) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText("");
  };
  return (
    <div className="rounded-md" style={{ border: `1px dashed ${ACCENT}` }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        placeholder={placeholder}
        rows={2}
        className="block w-full px-3 pt-2 text-xs outline-none resize-none bg-transparent placeholder:text-[#5b5b63]"
        style={{ color: C.text }}
      />
      <div className="flex justify-between items-center px-3 pb-2 text-[10px]" style={{ color: C.faint }}>
        <span className="truncate">Enter adds · Shift+Enter for a new line</span>
        <button onClick={submit} disabled={!text.trim()} className="shrink-0 whitespace-nowrap disabled:opacity-40" style={{ color: ACCENT }}>Add note</button>
      </div>
    </div>
  );
}

// A passage's notes floating above its line, anchored to the ✎ marker. Shown while the marker is hovered, kept open once it is clicked.
// The first line has no room above it, so its notes float below instead. The padding keeps the hover unbroken between marker and box.
function NotesPopover({ brief, at, pinned, below, onClose, onEdit, onRemove }) {
  return (
    <div className={`absolute left-0 z-20 cursor-default ${below ? "top-full pt-1.5" : "bottom-full pb-1.5"}`} style={{ width: 300 }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="rounded-lg p-2 select-text text-left leading-4" style={{ background: C.panel, color: C.text, border: `1px solid ${pinned ? ACCENT : C.line}`, boxShadow: "0 10px 30px rgba(0,0,0,.55)" }}>
        <div className="flex items-center justify-between text-[11px] px-1 mb-1.5" style={{ color: C.faint }}>
          <span>{plural(brief.notes.length, "note")} at {fmt(at)}{pinned ? "" : " · click ✎ to keep open"}</span>
          <button onClick={onClose} className="text-base leading-none px-1" style={{ color: C.mute }} title="Close">×</button>
        </div>
        <div className="flex flex-col gap-1.5">
          {brief.notes.map((n) => <NoteRow key={n.id} item={n} onChange={(text) => onEdit(n.id, text)} onRemove={() => onRemove(n.id)} />)}
        </div>
      </div>
    </div>
  );
}

// ---------- Shell ----------
export default function App() {
  const [view, setView] = useState("new"); // new | processing | brief | jobs | images | audio | notes
  const [jobs, setJobs] = useState([]);
  const [draft, setDraft] = useState(null); // { name, reference, file, url, lines, briefs }
  const [openJob, setOpenJob] = useState(null);

  // Library: every image, audio file and editing note the client has ever added (persisted in IndexedDB)
  const [library, setLibrary] = useState({ images: [], audio: [], notes: [] });
  const libRef = useRef(library);
  libRef.current = library;
  useEffect(() => {
    loadAssets()
      .then((assets) => {
        const all = assets
          .map((a) => (a.blob ? { ...a, url: URL.createObjectURL(a.blob) } : a))
          .sort((x, y) => y.addedAt - x.addedAt || (x.name || x.text || "").localeCompare(y.name || y.text || ""));
        setLibrary({ images: all.filter((a) => a.kind === "images"), audio: all.filter((a) => a.kind === "audio"), notes: all.filter((a) => a.kind === "notes") });
      })
      .catch(() => {});
  }, []);

  // Adds files to the library (re-using a record when the same file was uploaded before) and returns the library records for them
  const addToLibrary = (kind, files) => {
    const existing = libRef.current[kind];
    const added = [];
    const records = [...files].map((f) => {
      const same = (a) => a.name === f.name && a.size === f.size && a.type === f.type;
      const dup = existing.find(same) || added.find(same);
      if (dup) return dup;
      const rec = { id: aid(), kind, name: f.name, type: f.type, size: f.size, blob: f, addedAt: Date.now(), url: URL.createObjectURL(f) };
      if (kind === "audio") rec.tag = "music";
      added.push(rec);
      return rec;
    });
    if (added.length) {
      const next = { ...libRef.current, [kind]: [...added, ...existing] };
      libRef.current = next;
      setLibrary(next);
      added.forEach((r) => saveAsset(r).catch(() => {}));
    }
    return records;
  };
  const removeFromLibrary = (kind, id) => {
    setLibrary((l) => ({ ...l, [kind]: l[kind].filter((a) => a.id !== id) }));
    deleteAsset(id).catch(() => {});
  };
  const tagAudio = (id, tag) => {
    setLibrary((l) => ({ ...l, audio: l.audio.map((a) => (a.id === id ? { ...a, tag } : a)) }));
    updateAsset(id, { tag }).catch(() => {});
  };
  // Notes aren't files, so they skip the upload path: the text itself is the library record (re-used when the same note was written before)
  const addNoteToLibrary = (text) => {
    const t = text.trim();
    const dup = libRef.current.notes.find((a) => a.text === t);
    if (dup) return dup;
    const rec = { id: aid(), kind: "notes", text: t, addedAt: Date.now() };
    const next = { ...libRef.current, notes: [rec, ...libRef.current.notes] };
    libRef.current = next;
    setLibrary(next);
    saveAsset(rec).catch(() => {});
    return rec;
  };
  const editLibraryNote = (id, text) => {
    setLibrary((l) => ({ ...l, notes: l.notes.map((a) => (a.id === id ? { ...a, text } : a)) }));
    updateAsset(id, { text }).catch(() => {});
  };

  const startRequest = (d) => {
    setDraft(d);
    setView("processing");
  };
  const transcribed = (lines) => {
    setDraft((d) => ({ ...d, lines, briefs: [] }));
    setView("brief");
  };
  // Briefs live on the draft so a trip to the library doesn't lose in-progress work
  const setBriefs = (upd) => setDraft((d) => ({ ...d, briefs: typeof upd === "function" ? upd(d.briefs) : upd }));
  const submit = (briefs) => {
    const job = { ...draft, briefs, id: nid(), status: "Unassigned", editor: "—", date: new Date() };
    setJobs((j) => [job, ...j]);
    setDraft(null);
    setView("jobs");
  };

  const requestView = !draft ? "new" : draft.lines ? "brief" : "processing";
  const inRequest = ["new", "processing", "brief"].includes(view);

  return (
    <div className="min-h-screen flex text-[14px]" style={{ background: C.bg, color: C.text, fontFamily: "Inter, -apple-system, system-ui, sans-serif" }}>
      <aside className="w-52 shrink-0 p-5 flex flex-col gap-1" style={{ borderRight: `1px solid ${C.line}` }}>
        <div className="flex items-center gap-2 mb-6">
          <span className="w-6 h-6 rounded-md grid place-items-center font-semibold text-xs" style={{ background: ACCENT, color: ON_ACCENT }}>a</span>
          <span className="font-semibold">alfonso edits</span>
        </div>
        <div className="text-[11px] mb-1" style={{ color: C.faint }}>Work</div>
        <NavItem active={view === "jobs"} onClick={() => setView("jobs")}>My jobs {jobs.length ? <span style={{ color: C.mute }}>· {jobs.length}</span> : null}</NavItem>
        <NavItem active={inRequest} onClick={() => setView(requestView)}>+ New request</NavItem>
        <div className="text-[11px] mt-5 mb-1" style={{ color: C.faint }}>Library</div>
        <NavItem active={view === "images"} onClick={() => setView("images")}>Images {library.images.length ? <span style={{ color: C.mute }}>· {library.images.length}</span> : null}</NavItem>
        <NavItem active={view === "audio"} onClick={() => setView("audio")}>Music & SFX {library.audio.length ? <span style={{ color: C.mute }}>· {library.audio.length}</span> : null}</NavItem>
        <NavItem active={view === "notes"} onClick={() => setView("notes")}>Editing notes {library.notes.length ? <span style={{ color: C.mute }}>· {library.notes.length}</span> : null}</NavItem>
      </aside>

      <main className="flex-1 min-w-0 overflow-auto">
        {view === "new" && <NewRequest onContinue={startRequest} />}
        {view === "processing" && <Processing draft={draft} onDone={transcribed} onBack={() => { setDraft(null); setView("new"); }} />}
        {view === "brief" && draft && <BriefEditor draft={draft} setBriefs={setBriefs} library={library} addToLibrary={addToLibrary} addNoteToLibrary={addNoteToLibrary} onSubmit={submit} />}
        {view === "jobs" && <Jobs jobs={jobs} open={openJob} setOpen={setOpenJob} setJobs={setJobs} />}
        {view === "images" && <ImageGallery items={library.images} jobs={jobs} onAdd={(files) => addToLibrary("images", files)} onRemove={(id) => removeFromLibrary("images", id)} />}
        {view === "audio" && <AudioGallery items={library.audio} jobs={jobs} onAdd={(files) => addToLibrary("audio", files)} onRemove={(id) => removeFromLibrary("audio", id)} onTag={tagAudio} />}
        {view === "notes" && <NotesGallery items={library.notes} jobs={jobs} onAdd={addNoteToLibrary} onEdit={editLibraryNote} onRemove={(id) => removeFromLibrary("notes", id)} />}
      </main>
    </div>
  );
}

function NavItem({ active, children, onClick }) {
  return (
    <button onClick={onClick} className="text-left px-2 py-1.5 rounded-md w-full" style={{ background: active ? C.panel : "transparent", color: active ? C.text : C.mute }}>
      {children}
    </button>
  );
}

// ---------- 1. New request ----------
function NewRequest({ onContinue }) {
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [file, setFile] = useState(null);
  const [err, setErr] = useState("");
  const inp = useRef();

  const pick = (f) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) return setErr("That isn't a video file. Use MP4, MOV or WebM.");
    setErr("");
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
  };

  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">New request</h1>
      <p className="mb-8" style={{ color: C.mute }}>Add your clip. Each clip becomes its own request on the next screen.</p>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jas #1" className={inputCls} style={inputStyle} /></Field>
        <Field label="Reference"><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Instagram reel URL, or a short label" className={inputCls} style={inputStyle} /></Field>
      </div>

      <div className="text-[11px] mb-2" style={{ color: C.faint }}>Raw clip</div>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}
        onClick={() => inp.current.click()}
        className="rounded-xl p-10 text-center cursor-pointer"
        style={{ background: C.panel, border: `1px dashed ${C.line}` }}
      >
        <input ref={inp} type="file" accept="video/*" className="hidden" onChange={(e) => pick(e.target.files[0])} />
        {file ? (
          <div className="flex items-center justify-between text-left">
            <div>
              <div className="font-medium">{file.name}</div>
              <div style={{ color: C.mute }}>{(file.size / 1e6).toFixed(1)} MB · ready to transcribe</div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); setFile(null); }} style={{ color: C.mute }}>Replace</button>
          </div>
        ) : (
          <>
            <div className="mx-auto w-9 h-9 rounded-full grid place-items-center mb-3" style={{ border: `1px solid ${C.line}` }}>↑</div>
            <div className="font-medium">Add your clip</div>
            <div className="mt-1" style={{ color: C.mute }}>Straight off the camera roll · any format · as many as you shot</div>
            <div className="inline-block mt-4 px-3 py-1.5 rounded-md" style={{ background: C.bg, border: `1px solid ${C.line}` }}>Choose clip</div>
          </>
        )}
      </div>
      {err && <p className="mt-2" style={{ color: "#ff7a7a" }}>{err}</p>}

      <div className="mt-8 flex items-center gap-4">
        <button
          disabled={!file}
          onClick={() => onContinue({ name: name || "Untitled", reference, file, url: URL.createObjectURL(file) })}
          className="px-4 py-2 rounded-md font-medium disabled:opacity-40"
          style={{ background: ACCENT, color: ON_ACCENT }}
        >
          Transcribe and build brief
        </button>
        <button
          onClick={() => onContinue({ name: name || "Demo clip", reference, file: null, url: null })}
          style={{ color: C.mute }}
        >
          Try with a demo clip
        </button>
      </div>
    </div>
  );
}

const inputCls = "w-full px-3 py-2 rounded-md outline-none focus:ring-2";
const inputStyle = { background: C.panel, border: `1px solid ${C.line}`, color: C.text };
function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] mb-1.5" style={{ color: C.faint }}>{label}</div>
      {children}
    </label>
  );
}

// ---------- 2. Processing ----------
// Real clips: decode the sound track, hand it to the Whisper worker, and show download / transcription progress
// with the text as it streams in. The demo clip just loads DEMO_LINES.
function Processing({ draft, onDone, onBack }) {
  const [stage, setStage] = useState({ label: draft.file ? "Reading the clip's audio…" : "Loading the demo transcript…", pct: null });
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!draft.file) {
      const t = setTimeout(() => onDone(parseTranscript(DEMO_LINES)), 900);
      return () => clearTimeout(t);
    }
    let live = true;
    const worker = new Worker(new URL("./transcribe.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (!live) return;
      if (data.type === "stage") setStage({ label: data.label, pct: data.pct });
      else if (data.type === "partial") setPartial(data.text);
      else if (data.type === "error") setError(data.message);
      else if (data.type === "done") {
        const lines = linesFromWords(data.words);
        if (lines.length) onDone(lines);
        else setError("No speech was found in this clip.");
      }
    };
    worker.onerror = (e) => { if (live) setError(e.message || "The transcriber stopped unexpectedly."); };
    decodeAudio(draft.file)
      .then((audio) => { if (live) worker.postMessage({ audio }, [audio.buffer]); })
      .catch((e) => { if (live) setError(`Couldn't read the clip's audio (${e.message}). Is it a video with a sound track?`); });
    return () => { live = false; worker.terminate(); };
  }, []);

  return (
    <div className="h-full min-h-[70vh] grid place-items-center">
      <div className="w-[28rem] max-w-full text-center">
        <div className="font-semibold mb-1">{error ? "Couldn't transcribe this clip" : "Getting your clip ready"}</div>
        {error ? (
          <>
            <div className="mb-6" style={{ color: C.mute }}>{error}</div>
            <div className="flex justify-center gap-3">
              <button onClick={onBack} className="px-3 py-1.5 rounded-md" style={{ background: C.panel, border: `1px solid ${C.line}` }}>Back</button>
              <button onClick={() => onDone(parseTranscript(DEMO_LINES))} className="px-3 py-1.5 rounded-md font-medium" style={{ background: ACCENT, color: ON_ACCENT }}>Use the demo transcript</button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-6" style={{ color: C.mute }}>Turning the audio into a transcript with a time for every word. The brief editor opens when it's ready.</div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: C.line }}>
              <div className={`h-full rounded-full ${stage.pct == null ? "animate-pulse" : ""}`} style={{ width: `${stage.pct ?? 100}%`, background: ACCENT, transition: "width .15s" }} />
            </div>
            <div className="mt-2 text-xs" style={{ color: C.faint }}>{stage.label}{stage.pct != null ? ` ${Math.round(stage.pct)}%` : ""} · {draft.name}</div>
            {partial && (
              <div className="mt-5 text-left text-xs leading-relaxed rounded-lg p-3 max-h-32 overflow-hidden" style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.mute }}>
                {partial.length > 400 ? "…" : ""}{partial.slice(-400)}
              </div>
            )}
            {draft.file && <div className="mt-4 text-[11px]" style={{ color: C.faint }}>Runs on your device — nothing is uploaded. The first clip downloads a ~90 MB speech model, which is kept for next time.</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- 3. Build the brief ----------
function BriefEditor({ draft, setBriefs, library, addToLibrary, addNoteToLibrary, onSubmit }) {
  const lines = draft.lines;
  const briefs = draft.briefs; // { id, li, a, b, images:[{id,assetId,url,name}], audio:[{id,assetId,url,name}], notes:[{id,assetId,text}] }
  const [sel, setSel] = useState({ li: 0, a: 0, b: lines[0].words.length - 1 }); // line index, word range; null while the clip plays
  const [drag, setDrag] = useState(null);
  const [hoverNotes, setHoverNotes] = useState(null); // brief id whose ✎ marker is under the cursor
  const [pinnedNotes, setPinnedNotes] = useState(null); // brief id whose notes were pinned open by clicking the marker
  const [toast, setToast] = useToast();
  const { playing, toggle } = usePlayer();
  const imgInp = useRef();
  const audInp = useRef();

  // Preview playhead. The video drives it while playing; clicking the transcript or dragging the scrub bar moves both.
  const videoRef = useRef();
  const [time, setTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const duration = videoDur || lineEnd(lines, lines.length - 1); // transcript length until the video reports its own
  const seek = (t) => {
    const clamped = Math.max(0, Math.min(duration, t));
    setTime(clamped);
    if (videoRef.current) videoRef.current.currentTime = clamped;
  };
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  // While the clip plays the transcript follows it: play clears the selection and the word under the playhead is lit instead.
  // Choosing a passage pauses the clip, so the two highlights never show at once.
  useEffect(() => {
    if (!videoPlaying) return;
    let raf = requestAnimationFrame(function tick() {
      setTime(videoRef.current?.currentTime ?? 0);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [videoPlaying]);
  const live = !sel && draft.url ? wordAt(lines, time) : null;
  const pick = (range, t) => {
    videoRef.current?.pause();
    setSel(range);
    seek(t);
  };

  const current = useMemo(
    () => (sel ? briefs.find((b) => b.li === sel.li && b.a === sel.a && b.b === sel.b) : null),
    [briefs, sel]
  );
  // Library items not already on the selected passage, offered for reuse
  const libImages = library.images.filter((a) => !current?.images.some((x) => x.assetId === a.id));
  const libAudio = library.audio.filter((a) => !current?.audio.some((x) => x.assetId === a.id));
  const libNotes = library.notes.filter((a) => !current?.notes.some((x) => x.assetId === a.id));

  const start = sel ? wordTime(lines, sel.li, sel.a) : 0;
  const end = !sel ? 0 : sel.b === lines[sel.li].words.length - 1 ? wordTime(lines, sel.li, lines[sel.li].words.length) : wordTime(lines, sel.li, sel.b + 1);
  const quote = sel ? lines[sel.li].words.slice(sel.a, sel.b + 1).join(" ") : "";

  // New uploads go to the library first, then onto the passage
  const addFiles = (kind, files) => {
    const { ok, skipped } = splitFiles(kind, files);
    if (skipped) setToast(`Some files were skipped — ${MEDIA[kind].hint}.`);
    if (ok.length) attach(kind, addToLibrary(kind, ok));
  };
  const dropFiles = (files) => {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    const aud = [...files].filter((f) => !f.type.startsWith("image/"));
    if (imgs.length) addFiles("images", imgs);
    if (aud.length) addFiles("audio", aud);
  };
  // A new note is saved to the library first too, then put on the passage
  const addNote = (text) => attach("notes", [addNoteToLibrary(text)]);
  const attach = (kind, assets) => {
    if (!sel) return setToast("Pick a passage first — click a word or drag across a few.");
    const fresh = assets.filter((a) => !current?.[kind].some((x) => x.assetId === a.id));
    if (!fresh.length) return setToast("Already on this passage.");
    const items = fresh.map((a) => (kind === "notes" ? { id: nid(), assetId: a.id, text: a.text } : { id: nid(), assetId: a.id, url: a.url, name: a.name }));
    setBriefs((bs) => {
      const i = bs.findIndex((b) => b.li === sel.li && b.a === sel.a && b.b === sel.b);
      if (i === -1) return [...bs, { id: nid(), li: sel.li, a: sel.a, b: sel.b, images: [], audio: [], notes: [], [kind]: items }];
      const copy = [...bs];
      copy[i] = { ...copy[i], [kind]: [...copy[i][kind], ...items] };
      return copy;
    });
    setToast(`${plural(items.length, LABEL[kind])} added to this passage.`);
  };
  const removeItem = (kind, itemId) =>
    setBriefs((bs) => bs.map((b) => ({ ...b, [kind]: b[kind].filter((x) => x.id !== itemId) })).filter((b) => b.images.length || b.audio.length || b.notes.length));
  // Rewording a note on a passage leaves the library copy as it was
  const editNote = (itemId, text) => setBriefs((bs) => bs.map((b) => ({ ...b, notes: b.notes.map((n) => (n.id === itemId ? { ...n, text } : n)) })));

  // word selection by drag
  const onDown = (li, wi) => { setDrag({ li, wi }); pick({ li, a: wi, b: wi }, wordTime(lines, li, wi)); };
  const onEnter = (li, wi) => { if (drag && drag.li === li) setSel({ li, a: Math.min(drag.wi, wi), b: Math.max(drag.wi, wi) }); };
  useEffect(() => {
    const up = () => setDrag(null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const downloadTranscript = () => {
    const out = lines.map((l, li) => {
      const bs = briefs.filter((b) => b.li === li);
      const notes = bs.map((b) => {
        const media = [
          b.images.length && `images: ${b.images.map((i) => i.name).join(", ")}`,
          b.audio.length && `audio: ${b.audio.map((i) => i.name).join(", ")}`,
          b.notes.length && `notes: ${b.notes.map((n) => `"${n.text.replace(/\s*\n\s*/g, " ")}"`).join(" / ")}`,
        ].filter(Boolean).join(" · ");
        return `    ↳ "${l.words.slice(b.a, b.b + 1).join(" ")}" → ${media}`;
      });
      return [`[${fmt(l.t)}] ${l.words.join(" ")}`, ...notes].join("\n");
    }).join("\n");
    const blob = new Blob([`${draft.name}\n${draft.reference || ""}\n\n${out}`], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${draft.name}-brief.txt`;
    a.click();
  };

  return (
    <div className="px-8 py-8 select-none">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Build the brief</h1>
        <button onClick={downloadTranscript} style={{ color: ACCENT }}>Download transcript</button>
      </div>
      <p className="mb-6" style={{ color: C.mute }}>Click a word or timestamp to jump the preview there, or drag across words to highlight a passage. Add images, music or SFX, and editing notes for that passage in the panel.</p>

      <div className="flex gap-6 items-start">
        {/* Video preview */}
        <div className="w-40 shrink-0">
          <div className="rounded-lg overflow-hidden aspect-[9/16]" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
            {draft.url ? (
              <video
                ref={videoRef}
                src={draft.url}
                playsInline
                onClick={togglePlay}
                onTimeUpdate={(e) => setTime(e.target.currentTime)}
                onDurationChange={(e) => setVideoDur(Number.isFinite(e.target.duration) ? e.target.duration : 0)}
                onPlay={() => { setVideoPlaying(true); setSel(null); }}
                onPause={() => setVideoPlaying(false)}
                className="w-full h-full object-cover cursor-pointer"
              />
            ) : (
              <div className="h-full grid place-items-center text-center px-3 text-xs" style={{ color: C.faint }}>Demo clip — no video attached</div>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <PlayToggle on={videoPlaying} onClick={togglePlay} disabled={!draft.url} title={draft.url ? undefined : "No video to play"} />
            <ScrubBar time={time} duration={duration} onSeek={seek} />
          </div>
          <div className="flex justify-between text-xs" style={{ color: C.faint }}><span>{fmt(time)}</span><span>{fmt(duration)}</span></div>
          <div className="mt-1 text-xs truncate" style={{ color: C.faint }} title={draft.name}>{draft.name}</div>
        </div>

        {/* Transcript */}
        <div className="flex-1 min-w-0 rounded-xl p-4" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
          <div className="flex justify-between text-xs mb-3" style={{ color: C.faint }}><span>Transcript</span><span>{lines.length} lines</span></div>
          {lines.map((l, li) => {
            const lineSel = sel?.li === li;
            const lineLive = live?.li === li;
            const lineBriefs = briefs.filter((b) => b.li === li);
            const hasThumbs = lineBriefs.length > 0;
            return (
              <div key={l.id} className="flex gap-4 rounded-lg px-2" style={{ background: lineSel || lineLive ? tint(0.08) : "transparent", paddingTop: hasThumbs ? 46 : 10, paddingBottom: 10 }}>
                <button className="text-xs shrink-0 w-11 text-left mt-0.5" style={{ color: ACCENT }} onClick={() => pick({ li, a: 0, b: l.words.length - 1 }, l.t)}>{fmt(l.t)}</button>
                <div className="leading-7 flex flex-wrap">
                  {l.words.map((w, wi) => {
                    const inSel = lineSel && wi >= sel.a && wi <= sel.b;
                    const isLive = lineLive && live.wi === wi;
                    const owner = lineBriefs.find((b) => wi >= b.a && wi <= b.b);
                    const isFirst = owner && wi === owner.a;
                    const maxThumbs = 4 - (owner?.audio.length ? 1 : 0) - (owner?.notes.length ? 1 : 0);
                    return (
                      <span
                        key={wi}
                        onMouseDown={(e) => { e.preventDefault(); onDown(li, wi); }}
                        onMouseEnter={() => onEnter(li, wi)}
                        className="relative cursor-text px-0.5 rounded-sm"
                        style={{
                          background: isLive ? ACCENT : inSel ? tint(0.28) : "transparent",
                          color: isLive ? ON_ACCENT : undefined,
                          boxShadow: owner ? `inset 0 -2px 0 ${ACCENT}` : "none",
                        }}
                      >
                        {w}
                        {isFirst && (
                          <span className="absolute left-0 flex gap-0.5 p-0.5 rounded-md" style={{ top: -40, background: C.bg, border: `1px solid ${ACCENT}` }}
                            onMouseDown={(e) => { e.stopPropagation(); pick({ li, a: owner.a, b: owner.b }, wordTime(lines, li, owner.a)); }}>
                            {owner.images.slice(0, maxThumbs).map((im) => <img key={im.id} src={im.url} className="w-7 h-7 object-cover rounded" alt="" />)}
                            {owner.images.length > maxThumbs && <span className="w-7 h-7 grid place-items-center text-[10px]" style={{ color: C.mute }}>+{owner.images.length - maxThumbs}</span>}
                            {owner.audio.length > 0 && <span className="w-7 h-7 grid place-items-center text-xs rounded" style={{ color: ACCENT, background: C.panel }} title={plural(owner.audio.length, "track")}>♪</span>}
                            {owner.notes.length > 0 && (
                              <span
                                className="relative w-7 h-7 grid place-items-center text-xs rounded cursor-pointer"
                                style={pinnedNotes === owner.id ? { color: ON_ACCENT, background: ACCENT } : { color: ACCENT, background: C.panel }}
                                aria-label={plural(owner.notes.length, "note")}
                                onMouseEnter={() => setHoverNotes(owner.id)}
                                onMouseLeave={() => setHoverNotes(null)}
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  if (pinnedNotes === owner.id) { setPinnedNotes(null); setHoverNotes(null); }
                                  else setPinnedNotes(owner.id);
                                }}
                              >
                                ✎
                                {(hoverNotes === owner.id || pinnedNotes === owner.id) && (
                                  <NotesPopover
                                    brief={owner}
                                    at={wordTime(lines, li, owner.a)}
                                    pinned={pinnedNotes === owner.id}
                                    below={li === 0}
                                    onClose={() => { setPinnedNotes(null); setHoverNotes(null); }}
                                    onEdit={editNote}
                                    onRemove={(id) => removeItem("notes", id)}
                                  />
                                )}
                              </span>
                            )}
                          </span>
                        )}
                        {" "}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Media panel */}
        <div className="w-72 shrink-0 rounded-xl p-4 flex flex-col" style={{ background: C.panel, border: `1px solid ${C.line}`, minHeight: 520 }}>
          {sel ? (
            <>
              <div className="text-xs mb-1" style={{ color: ACCENT }}>{fmt(start)} – {fmt(end)}</div>
              <div className="mb-4 leading-snug" style={{ color: C.mute }}>“{quote}”</div>

              <div className="text-xs mb-2" style={{ color: C.faint }}>Images</div>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => imgInp.current.click()} className="aspect-square rounded-md grid place-items-center text-xl" style={{ border: `1px dashed ${ACCENT}`, color: ACCENT }} title="Add images">+</button>
                {current?.images.map((im) => (
                  <button key={im.id} onClick={() => removeItem("images", im.id)} className="aspect-square rounded-md overflow-hidden relative group" title="Remove">
                    <img src={im.url} className="w-full h-full object-cover" alt={im.name} />
                    <span className="absolute inset-0 hidden group-hover:grid place-items-center text-xs" style={{ background: "rgba(0,0,0,.6)" }}>Remove</span>
                  </button>
                ))}
              </div>
              <input ref={imgInp} type="file" accept={MEDIA.images.accept} multiple className="hidden" onChange={(e) => { addFiles("images", e.target.files); e.target.value = ""; }} />

              {libImages.length > 0 && (
                <div className="mt-3">
                  <div className="flex justify-between text-[11px] mb-1.5" style={{ color: C.faint }}><span>From your image library</span><span>{libImages.length}</span></div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {libImages.slice(0, 8).map((a) => (
                      <button key={a.id} onClick={() => attach("images", [a])} className="aspect-square rounded overflow-hidden opacity-70 hover:opacity-100" title={`Use ${a.name} here`}>
                        <img src={a.url} className="w-full h-full object-cover" alt="" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="text-xs mt-5 mb-2" style={{ color: C.faint }}>Music & SFX</div>
              <div className="flex flex-col gap-1.5">
                {current?.audio.map((tr) => <AudioRow key={tr.id} item={tr} playing={playing} toggle={toggle} onRemove={() => removeItem("audio", tr.id)} />)}
                <button onClick={() => audInp.current.click()} className="rounded-md px-3 py-2 text-left text-xs" style={{ border: `1px dashed ${ACCENT}`, color: ACCENT }} title="Add music or SFX">+ Add music or SFX</button>
              </div>
              <input ref={audInp} type="file" accept={MEDIA.audio.accept} multiple className="hidden" onChange={(e) => { addFiles("audio", e.target.files); e.target.value = ""; }} />

              {libAudio.length > 0 && (
                <div className="mt-3">
                  <div className="flex justify-between text-[11px] mb-1.5" style={{ color: C.faint }}><span>From your music & SFX library</span><span>{libAudio.length}</span></div>
                  <div className="flex flex-col gap-1">
                    {libAudio.slice(0, 4).map((a) => (
                      <button key={a.id} onClick={() => attach("audio", [a])} className="flex items-center gap-2 text-left text-xs px-2 py-1 rounded-md opacity-70 hover:opacity-100" style={{ border: `1px solid ${C.line}` }} title={`Use ${a.name} here`}>
                        <span className="shrink-0 text-[10px] w-7" style={{ color: ACCENT }}>{a.tag === "sfx" ? "SFX" : "♪"}</span>
                        <span className="truncate">{a.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="text-xs mt-5 mb-2" style={{ color: C.faint }}>Editing notes</div>
              <div className="flex flex-col gap-1.5 select-text">
                {current?.notes.map((n) => <NoteRow key={n.id} item={n} onChange={(text) => editNote(n.id, text)} onRemove={() => removeItem("notes", n.id)} />)}
                <NoteComposer onAdd={addNote} placeholder="Tell the editor what to do here — e.g. punch in, caption this line" />
              </div>

              {libNotes.length > 0 && (
                <div className="mt-3">
                  <div className="flex justify-between text-[11px] mb-1.5" style={{ color: C.faint }}><span>From your notes library</span><span>{libNotes.length}</span></div>
                  <div className="flex flex-col gap-1">
                    {libNotes.slice(0, 4).map((a) => (
                      <button key={a.id} onClick={() => attach("notes", [a])} className="flex items-center gap-2 text-left text-xs px-2 py-1 rounded-md opacity-70 hover:opacity-100" style={{ border: `1px solid ${C.line}` }} title={`Use "${a.text}" here`}>
                        <span className="shrink-0 text-[10px] w-7" style={{ color: ACCENT }}>✎</span>
                        <span className="truncate">{a.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div
                className="mt-auto pt-6 text-center text-xs"
                style={{ color: C.faint }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); dropFiles(e.dataTransfer.files); }}
              >
                Click + or drop files here<br />{MEDIA.images.hint}<br />{MEDIA.audio.hint}
              </div>
            </>
          ) : (
            <div className="my-auto text-center leading-relaxed px-2" style={{ color: C.mute }}>
              {live ? (
                <>
                  <div className="text-xs mb-2" style={{ color: ACCENT }}>Following the clip</div>
                  <div className="mb-4" style={{ color: C.text }}>“{lines[live.li].words.join(" ")}”</div>
                </>
              ) : (
                <div className="mb-2">Nothing selected</div>
              )}
              <div className="text-xs" style={{ color: C.faint }}>Click a word or drag across a few to choose a passage, then add images, music or notes for it.</div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-4">
        <button onClick={() => onSubmit(briefs)} className="px-4 py-2 rounded-md font-medium" style={{ background: ACCENT, color: ON_ACCENT }}>Send to editor</button>
        <span style={{ color: C.mute }}>{briefs.length ? `${plural(briefs.length, "passage")} with media or notes` : "Nothing attached yet — the editor will cut without a brief."}</span>
      </div>

      <Toast text={toast} />
    </div>
  );
}

// ---------- 4. Queue ----------
const STATUSES = ["Unassigned", "Editing", "In review", "Needs revision"];
function Jobs({ jobs, open, setOpen, setJobs }) {
  const counts = STATUSES.map((s) => jobs.filter((j) => j.status === s).length);
  const { playing, toggle } = usePlayer();
  const advance = (id) =>
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, status: STATUSES[(STATUSES.indexOf(j.status) + 1) % STATUSES.length], editor: j.editor === "—" ? "Alfonso" : j.editor } : j)));
  const job = jobs.find((j) => j.id === open);

  return (
    <div className="px-8 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Queue</h1>
        <span className="text-xs" style={{ color: C.faint }}>{jobs.filter((j) => j.status !== "In review").length} of {jobs.length} open · {jobs.length} total</span>
      </div>

      <div className="grid grid-cols-4 rounded-xl mb-6" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
        {STATUSES.map((s, i) => (
          <div key={s} className="p-4" style={{ borderLeft: i ? `1px solid ${C.line}` : "none" }}>
            <div className="text-[11px] mb-1" style={{ color: C.faint }}>{s}</div>
            <div className="text-2xl font-semibold">{counts[i]}</div>
          </div>
        ))}
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-xl p-12 text-center" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
          <div className="font-medium mb-1">Queue is clear</div>
          <div style={{ color: C.mute }}>Send a request from New request and it lands here as Unassigned.</div>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
          <div className="grid grid-cols-[110px_1fr_140px_120px_140px] px-4 py-2 text-[11px]" style={{ color: C.faint, background: C.panel }}>
            <span>Date</span><span>Job</span><span>Reference</span><span>Editor</span><span>Status</span>
          </div>
          {jobs.map((j) => {
            const nImg = j.briefs.reduce((n, b) => n + b.images.length, 0);
            const nAud = j.briefs.reduce((n, b) => n + b.audio.length, 0);
            const nNotes = j.briefs.reduce((n, b) => n + b.notes.length, 0);
            return (
              <div key={j.id} className="grid grid-cols-[110px_1fr_140px_120px_140px] px-4 py-3 items-center" style={{ borderTop: `1px solid ${C.line}` }}>
                <span style={{ color: C.mute }}>{j.date.toLocaleDateString()}</span>
                <button className="text-left" onClick={() => setOpen(open === j.id ? null : j.id)}>
                  <span className="font-medium">{j.name}</span>
                  <span className="ml-2 text-xs" style={{ color: C.faint }}>{plural(j.briefs.length, "passage")} · {plural(nImg, "image")}{nAud ? ` · ${plural(nAud, "track")}` : ""}{nNotes ? ` · ${plural(nNotes, "note")}` : ""}</span>
                </button>
                <span className="truncate" style={{ color: C.mute }}>{j.reference || "—"}</span>
                <span style={{ color: C.mute }}>{j.editor}</span>
                <button onClick={() => advance(j.id)} className="text-left px-2 py-1 rounded-md w-fit text-xs" style={{ border: `1px solid ${C.line}`, color: j.status === "Needs revision" ? VIOLET : C.text }} title="Move to next status">{j.status}</button>
              </div>
            );
          })}
        </div>
      )}

      {job && (
        <div className="mt-6 rounded-xl p-5" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
          <div className="font-medium mb-3">Brief for {job.name} — what the editor sees</div>
          {job.briefs.length === 0 && <div style={{ color: C.mute }}>No passages were marked.</div>}
          {job.briefs.map((b) => {
            const l = job.lines[b.li];
            return (
              <div key={b.id} className="flex gap-4 py-3" style={{ borderTop: `1px solid ${C.line}` }}>
                <div className="w-24 text-xs shrink-0" style={{ color: ACCENT }}>{fmt(wordTime(job.lines, b.li, b.a))}</div>
                <div className="flex-1 min-w-0">
                  <div className="mb-2">“{l.words.slice(b.a, b.b + 1).join(" ")}”</div>
                  {b.images.length > 0 && <div className="flex gap-1.5 flex-wrap">{b.images.map((im) => <img key={im.id} src={im.url} className="w-14 h-14 object-cover rounded" alt={im.name} />)}</div>}
                  {b.audio.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap mt-2">
                      {b.audio.map((tr) => <div key={tr.id} className="w-64"><AudioRow item={tr} playing={playing} toggle={toggle} /></div>)}
                    </div>
                  )}
                  {b.notes.length > 0 && (
                    <div className="flex flex-col gap-1.5 mt-2 max-w-md">
                      {b.notes.map((n) => <NoteRow key={n.id} item={n} />)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- 5. Library ----------
// Page chrome for a library. Passing `accept` adds the upload button and lets files be dropped anywhere on the page.
function GalleryShell({ title, blurb, count, onAdd, accept, buttonLabel, children }) {
  const inp = useRef();
  return (
    <div className="px-8 py-8 min-h-full" onDragOver={accept ? (e) => e.preventDefault() : undefined} onDrop={accept ? (e) => { e.preventDefault(); onAdd(e.dataTransfer.files); } : undefined}>
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <span className="text-xs" style={{ color: C.faint }}>{count}</span>
      </div>
      <div className="flex items-center justify-between gap-6 mb-6">
        <p style={{ color: C.mute }}>{blurb}</p>
        {accept && (
          <>
            <button onClick={() => inp.current.click()} className="px-3 py-1.5 rounded-md shrink-0" style={{ background: C.panel, border: `1px solid ${C.line}` }}>{buttonLabel}</button>
            <input ref={inp} type="file" accept={accept} multiple className="hidden" onChange={(e) => { onAdd(e.target.files); e.target.value = ""; }} />
          </>
        )}
      </div>
      {children}
    </div>
  );
}
function EmptyLibrary({ children }) {
  return (
    <div className="rounded-xl p-12 text-center" style={{ background: C.panel, border: `1px dashed ${C.line}` }}>
      <div style={{ color: C.mute }}>{children}</div>
    </div>
  );
}
const addedOn = (a) => new Date(a.addedAt).toLocaleDateString();
const usage = (jobs, kind, id) => {
  const n = usedIn(jobs, kind, id);
  return n ? ` · in ${plural(n, "job")}` : "";
};

function ImageGallery({ items, jobs, onAdd, onRemove }) {
  const [toast, setToast] = useToast();
  const add = (files) => {
    const { ok, skipped } = splitFiles("images", files);
    if (skipped) setToast(`${plural(skipped, "file")} skipped — ${MEDIA.images.hint}.`);
    if (ok.length) { onAdd(ok); setToast(`${plural(ok.length, "image")} added to your library.`); }
  };
  return (
    <GalleryShell title="Image library" blurb="Every image you've ever added to a brief, kept here to reuse. Drop files anywhere on this page to add more." count={plural(items.length, "image")} onAdd={add} accept={MEDIA.images.accept} buttonLabel="Upload images">
      {items.length === 0 ? (
        <EmptyLibrary>No images yet. Images you attach to a passage are saved here automatically, or upload some now and reuse them later.</EmptyLibrary>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
          {items.map((im) => (
            <div key={im.id} className="group min-w-0">
              <div className="relative aspect-square rounded-lg overflow-hidden" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
                <img src={im.url} className="w-full h-full object-cover" alt={im.name} />
                <button onClick={() => onRemove(im.id)} className="absolute top-1.5 right-1.5 hidden group-hover:block px-1.5 py-0.5 rounded text-[10px]" style={{ background: "rgba(0,0,0,.7)" }} title="Remove from library">Remove</button>
              </div>
              <div className="mt-1.5 text-xs truncate" title={im.name}>{im.name}</div>
              <div className="text-[11px]" style={{ color: C.faint }}>{mb(im.size)} · {addedOn(im)}{usage(jobs, "images", im.id)}</div>
            </div>
          ))}
        </div>
      )}
      <Toast text={toast} />
    </GalleryShell>
  );
}

const AUDIO_TAGS = [["all", "All"], ["music", "Music"], ["sfx", "SFX"]];
function AudioGallery({ items, jobs, onAdd, onRemove, onTag }) {
  const [toast, setToast] = useToast();
  const [filter, setFilter] = useState("all");
  const { playing, toggle } = usePlayer();
  const shown = filter === "all" ? items : items.filter((a) => (a.tag || "music") === filter);
  const add = (files) => {
    const { ok, skipped } = splitFiles("audio", files);
    if (skipped) setToast(`${plural(skipped, "file")} skipped — ${MEDIA.audio.hint}.`);
    if (ok.length) { onAdd(ok); setToast(`${plural(ok.length, "track")} added to your library.`); }
  };
  return (
    <GalleryShell title="Music & SFX library" blurb="Every track you've ever added to a brief, kept here to reuse. Tap the tag to mark a track as music or a sound effect." count={plural(items.length, "track")} onAdd={add} accept={MEDIA.audio.accept} buttonLabel="Upload audio">
      {items.length === 0 ? (
        <EmptyLibrary>No music or SFX yet. Tracks you attach to a passage are saved here automatically, or upload some now and reuse them later.</EmptyLibrary>
      ) : (
        <>
          <div className="flex gap-1 mb-3">
            {AUDIO_TAGS.map(([key, label]) => (
              <button key={key} onClick={() => setFilter(key)} className="px-2.5 py-1 rounded-md text-xs" style={{ background: filter === key ? C.panel : "transparent", border: `1px solid ${filter === key ? C.line : "transparent"}`, color: filter === key ? C.text : C.mute }}>{label}</button>
            ))}
          </div>
          <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
            <div className="grid grid-cols-[36px_1fr_80px_90px_110px_70px] gap-3 px-4 py-2 text-[11px] items-center" style={{ color: C.faint, background: C.panel }}>
              <span /><span>Track</span><span>Type</span><span>Size</span><span>Added</span><span />
            </div>
            {shown.length === 0 && <div className="px-4 py-6 text-center text-xs" style={{ color: C.faint, borderTop: `1px solid ${C.line}` }}>Nothing tagged as {filter === "sfx" ? "SFX" : "music"} yet.</div>}
            {shown.map((a) => {
              const tag = a.tag || "music";
              const n = usedIn(jobs, "audio", a.id);
              return (
                <div key={a.id} className="grid grid-cols-[36px_1fr_80px_90px_110px_70px] gap-3 px-4 py-2.5 items-center" style={{ borderTop: `1px solid ${C.line}` }}>
                  <PlayButton url={a.url} playing={playing} toggle={toggle} />
                  <div className="min-w-0">
                    <div className="truncate" title={a.name}>{a.name}</div>
                    {n > 0 && <div className="text-[11px]" style={{ color: C.faint }}>in {plural(n, "job")}</div>}
                  </div>
                  <button onClick={() => onTag(a.id, tag === "music" ? "sfx" : "music")} className="w-fit px-2 py-0.5 rounded text-[11px]" style={{ border: `1px solid ${C.line}`, color: tag === "sfx" ? CYAN : ACCENT }} title="Click to switch between music and SFX">{tag === "sfx" ? "SFX" : "Music"}</button>
                  <span className="text-xs" style={{ color: C.mute }}>{mb(a.size)}</span>
                  <span className="text-xs" style={{ color: C.mute }}>{addedOn(a)}</span>
                  <button onClick={() => onRemove(a.id)} className="text-xs text-left" style={{ color: C.faint }} title="Remove from library">Remove</button>
                </div>
              );
            })}
          </div>
        </>
      )}
      <Toast text={toast} />
    </GalleryShell>
  );
}

function NotesGallery({ items, jobs, onAdd, onEdit, onRemove }) {
  const [toast, setToast] = useToast();
  const add = (text) => {
    const rec = onAdd(text);
    setToast(items.some((a) => a.id === rec.id) ? "That note is already in your library." : "Note added to your library.");
  };
  return (
    <GalleryShell title="Editing notes library" blurb="Every note you've written for an editor, kept here to reuse on later briefs. Click a note to reword it." count={plural(items.length, "note")}>
      <div className="max-w-xl mb-6"><NoteComposer onAdd={add} placeholder="Write a note to reuse — e.g. Captions on for the whole clip" /></div>
      {items.length === 0 ? (
        <EmptyLibrary>No notes yet. Notes you add to a passage are saved here automatically, or write some now and reuse them later.</EmptyLibrary>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
          <div className="grid grid-cols-[36px_1fr_110px_70px] gap-3 px-4 py-2 text-[11px] items-center" style={{ color: C.faint, background: C.panel }}>
            <span /><span>Note</span><span>Added</span><span />
          </div>
          {items.map((a) => {
            const n = usedIn(jobs, "notes", a.id);
            return (
              <div key={a.id} className="grid grid-cols-[36px_1fr_110px_70px] gap-3 px-4 py-2.5 items-start" style={{ borderTop: `1px solid ${C.line}` }}>
                <span className="w-6 h-6 grid place-items-center text-xs" style={{ color: ACCENT }}>✎</span>
                <div className="min-w-0 pt-0.5">
                  <NoteText text={a.text} onChange={(t) => onEdit(a.id, t)} />
                  {n > 0 && <div className="text-[11px] mt-0.5" style={{ color: C.faint }}>in {plural(n, "job")}</div>}
                </div>
                <span className="text-xs pt-1" style={{ color: C.mute }}>{addedOn(a)}</span>
                <button onClick={() => onRemove(a.id)} className="text-xs text-left pt-1" style={{ color: C.faint }} title="Remove from library">Remove</button>
              </div>
            );
          })}
        </div>
      )}
      <Toast text={toast} />
    </GalleryShell>
  );
}

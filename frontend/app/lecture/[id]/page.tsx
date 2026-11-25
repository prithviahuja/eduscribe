"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import AudioRecorder, { type AudioRecorderHandle } from "@/components/AudioRecorder";
import ChunkLog from "@/components/ChunkLog";
import NotesViewer from "@/components/NotesViewer";
import {
  processChunk, generateNotes, getLecture, saveLecture, errorMessage,
  type ChunkResult as Chunk, type Lecture,
} from "@/lib/api";

const NOTES_INTERVAL_S = 90;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Simple markdown to HTML converter for the printable PDF view
const markdownToHtml = (md: string) =>
  escapeHtml(md)
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/^---$/gm, "<hr>")
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return "";
      if (/^<li>/.test(b)) return `<ul>${b}</ul>`;
      if (/^<(h\d|hr|ul)/.test(b)) return b;
      return `<p>${b.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

export default function LecturePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [notes, setNotes] = useState("");
  const [pendingChunks, setPendingChunks] = useState(0);
  const [notesStatus, setNotesStatus] = useState<"idle" | "generating" | "ready">("idle");
  const [isRecording, setIsRecording] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [nextUpdateIn, setNextUpdateIn] = useState(NOTES_INTERVAL_S);

  const recorderRef = useRef<AudioRecorderHandle>(null);
  const lectureRef = useRef<Lecture | null>(null);
  const chunksRef = useRef<Chunk[]>([]);
  const notesRef = useRef("");
  const pendingRef = useRef<Set<Promise<void>>>(new Set());
  const notesIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartedRef = useRef(false);
  const recordStartRef = useRef<number | null>(null);
  const recordedSecondsRef = useRef(0);
  const generatingRef = useRef(false);

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { lectureRef.current = lecture; }, [lecture]);

  useEffect(() => {
    let cancelled = false;
    getLecture(id)
      .then((l) => {
        if (cancelled) return;
        setLecture(l);
        if (l.notes) { setNotes(l.notes); setNotesStatus("ready"); setIsSaved(true); }
      })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, [id]);

  /** Summaries already saved on the lecture + summaries from this session. */
  const allSummaries = () => [
    ...(lectureRef.current?.summaries || []),
    ...chunksRef.current.map((c) => c.summary),
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  const triggerNotesGeneration = useCallback(async () => {
    if (generatingRef.current) return;
    const summaries = allSummaries();
    if (summaries.length === 0) return;
    generatingRef.current = true;
    setNotesStatus("generating");
    try {
      const transcripts = chunksRef.current.map((c) => c.transcript).filter(Boolean);
      const l = lectureRef.current;
      const result = await generateNotes(summaries, transcripts, l?.ppt_text || "", l?.pyq_text || "", id);
      if (result.notes && result.notes.length > 20) {
        setNotes(result.notes);
        setNotesStatus("ready");
        setIsSaved(false);
      } else {
        setNotesStatus(notesRef.current ? "ready" : "idle");
      }
    } catch (e) {
      setError(`Notes generation failed: ${errorMessage(e)}`);
      setNotesStatus(notesRef.current ? "ready" : "idle");
    } finally {
      generatingRef.current = false;
    }
  }, [id]);

  const clearTimers = () => {
    if (notesIntervalRef.current) { clearInterval(notesIntervalRef.current); notesIntervalRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
  };

  useEffect(() => clearTimers, []);

  const startSession = () => {
    if (sessionStartedRef.current) return;
    sessionStartedRef.current = true;
    recordStartRef.current = Date.now();
    setIsRecording(true);
    clearTimers();
    setNextUpdateIn(NOTES_INTERVAL_S);
    notesIntervalRef.current = setInterval(() => {
      triggerNotesGeneration();
      setNextUpdateIn(NOTES_INTERVAL_S);
    }, NOTES_INTERVAL_S * 1000);
    countdownRef.current = setInterval(() => {
      setNextUpdateIn((p) => (p > 1 ? p - 1 : NOTES_INTERVAL_S));
    }, 1000);
  };

  const endSession = () => {
    if (!sessionStartedRef.current) return;
    sessionStartedRef.current = false;
    if (recordStartRef.current) {
      recordedSecondsRef.current += Math.floor((Date.now() - recordStartRef.current) / 1000);
      recordStartRef.current = null;
    }
    setIsRecording(false);
    clearTimers();
  };

  const handleStatusChange = (s: "idle" | "recording") => {
    if (s === "recording") startSession();
    else endSession();
  };

  const handleChunk = (blob: Blob) => {
    setPendingChunks((n) => n + 1);
    const p: Promise<void> = processChunk(blob)
      .then((result) => {
        if (result.transcript?.trim()) {
          // Keep the ref in sync immediately so notes generation sees it
          chunksRef.current = [...chunksRef.current, result];
          setChunks(chunksRef.current);
        }
        setError("");
      })
      .catch((e) => setError(`Chunk processing failed: ${errorMessage(e)}`))
      .finally(() => {
        pendingRef.current.delete(p);
        setPendingChunks((n) => n - 1);
      });
    pendingRef.current.add(p);
  };

  const handleEndLecture = async () => {
    await recorderRef.current?.stop();
    endSession();
    // Wait for in-flight chunks (including the final one) before the final notes pass
    await Promise.allSettled([...pendingRef.current]);
    await triggerNotesGeneration();
  };

  const handleSave = async () => {
    if (!notesRef.current || !lecture || saving) return;
    setSaving(true);
    try {
      const duration = (lecture.duration_seconds || 0) + recordedSecondsRef.current;
      const summaries = allSummaries();
      await saveLecture(id, summaries, notesRef.current, duration);
      // Saved summaries now live on the lecture; reset session-local state
      const updated = { ...lecture, summaries, notes: notesRef.current, duration_seconds: duration };
      lectureRef.current = updated;
      setLecture(updated);
      recordedSecondsRef.current = 0;
      chunksRef.current = [];
      setChunks([]);
      setIsSaved(true);
    } catch (e) {
      setError(`Save failed: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadPDF = () => {
    const content = notesRef.current;
    if (!content) return;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`
      <html>
        <head>
          <title>${escapeHtml(lecture?.title || "Lecture Notes")}</title>
          <style>
            body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #1a1a1a; line-height: 1.7; }
            h1 { font-size: 28px; border-bottom: 2px solid #333; padding-bottom: 10px; }
            h2 { font-size: 20px; margin-top: 30px; color: #222; }
            h3 { font-size: 16px; color: #333; margin-top: 20px; }
            strong { color: #111; }
            ul { padding-left: 20px; }
            li { margin: 4px 0; }
            hr { border: none; border-top: 1px solid #ddd; margin: 30px 0; }
            p { margin: 8px 0; }
          </style>
        </head>
        <body>
          <p style="color:#888;font-size:12px;font-family:sans-serif">Generated by EduScribe • ${new Date().toLocaleDateString()}</p>
          ${markdownToHtml(content)}
        </body>
      </html>
    `);
    win.document.close();
    win.focus();
    win.print();
  };

  const hasSummaries = chunks.length > 0 || (lecture?.summaries?.length ?? 0) > 0;
  const status = isRecording ? "recording" : pendingChunks > 0 ? "processing" : "idle";

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Top bar */}
      <div className="border-b border-gray-800 px-6 py-3 flex items-center justify-between shrink-0 gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <button onClick={() => router.push(lecture?.subject_id ? `/subject/${lecture.subject_id}` : "/")}
            className="text-gray-600 hover:text-gray-400 text-sm">← Back</button>
          <div className="min-w-0">
            <span className="font-semibold text-sm">{lecture?.title || (error ? "Lecture" : "Loading...")}</span>
            {isRecording && (
              <span className="ml-3 text-xs text-gray-600">
                Next notes in <span className="text-gray-400 font-mono">{nextUpdateIn}s</span>
              </span>
            )}
          </div>
          {lecture?.ppt_text && <span className="text-xs bg-indigo-900 text-indigo-300 px-2 py-0.5 rounded-full">PPT loaded</span>}
          {lecture?.pyq_text && <span className="text-xs bg-purple-900 text-purple-300 px-2 py-0.5 rounded-full">PYQs loaded</span>}
        </div>

        <div className="flex items-center gap-3">
          {error && (
            <span className="text-xs text-red-400 max-w-xs truncate" title={error}>
              {error}{" "}
              <button onClick={() => setError("")} className="underline ml-1">dismiss</button>
            </span>
          )}
          {notes && !isRecording && (
            <>
              <button onClick={handleDownloadPDF}
                className="text-xs border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white px-3 py-1.5 rounded-lg transition-colors">
                ↓ Download PDF
              </button>
              <button onClick={handleSave} disabled={saving || isSaved}
                className={`text-xs px-3 py-1.5 rounded-lg transition-colors font-medium ${
                  isSaved
                    ? "bg-green-900 text-green-400 border border-green-800"
                    : "bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
                }`}>
                {isSaved ? "✓ Saved" : saving ? "Saving..." : "Save Notes"}
              </button>
            </>
          )}
          {isRecording && (
            <button onClick={handleEndLecture}
              className="bg-orange-600 hover:bg-orange-500 text-white text-sm px-4 py-2 rounded-lg font-medium transition-colors">
              End Lecture →
            </button>
          )}
          <AudioRecorder ref={recorderRef} onChunkReady={handleChunk} onStatusChange={handleStatusChange} />
        </div>
      </div>

      {/* Split layout */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-2/5 border-r border-gray-800 overflow-y-auto p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600 uppercase tracking-widest">Live Chunks</span>
            <span className="text-xs text-gray-700">
              {status === "recording" && "🔴 live"}
              {status === "processing" && `⚙️ processing ${pendingChunks}`}
              {status === "idle" && chunks.length > 0 && `${chunks.length} chunks`}
            </span>
          </div>
          {chunks.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-gray-700 text-sm text-center px-4">
              {isSaved ? "This lecture already has saved notes. Start recording to add more." : "Start recording to see live chunks"}
            </div>
          ) : <ChunkLog chunks={chunks} />}
        </div>

        <div className="w-3/5 overflow-y-auto p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-semibold text-gray-600 uppercase tracking-widest">Structured Notes</span>
            <div className="flex items-center gap-3">
              {notesStatus === "generating" && <span className="text-xs text-blue-400 animate-pulse">✨ Generating...</span>}
              {notes && notesStatus !== "generating" && (
                <button onClick={() => navigator.clipboard?.writeText(notes)}
                  className="text-xs text-gray-600 hover:text-gray-400 underline">Copy</button>
              )}
              {!isRecording && hasSummaries && notesStatus !== "generating" && (
                <button onClick={triggerNotesGeneration}
                  className="text-xs border border-gray-700 hover:border-gray-500 text-gray-500 hover:text-gray-300 px-3 py-1 rounded-lg transition-colors">
                  {notes ? "Regenerate" : "Generate Now"}
                </button>
              )}
            </div>
          </div>

          {!notes && notesStatus === "idle" && (
            <div className="flex flex-col items-center justify-center flex-1 text-gray-700 text-sm gap-2">
              <p>Notes auto-generate every {NOTES_INTERVAL_S} seconds</p>
              <p className="text-xs text-gray-800">Click &quot;End Lecture&quot; for final generation</p>
            </div>
          )}
          {notesStatus === "generating" && !notes && (
            <div className="flex flex-col gap-4 mt-4">
              {[80, 95, 70, 60, 88, 75].map((w, i) => (
                <div key={i} className="h-3 bg-gray-800 rounded animate-pulse" style={{ width: `${w}%` }} />
              ))}
            </div>
          )}
          {notes && <NotesViewer notes={notes} sessionId={id} isUpdating={notesStatus === "generating"} />}
        </div>
      </div>
    </main>
  );
}

"use client";
import { useState, useRef, useImperativeHandle, useEffect } from "react";

export interface AudioRecorderHandle {
  /** Stops recording; resolves once the final chunk has been handed to onChunkReady. */
  stop: () => Promise<void>;
}

interface Props {
  onChunkReady: (blob: Blob) => void;
  onStatusChange: (status: "idle" | "recording") => void;
  chunkMs?: number;
  ref?: React.Ref<AudioRecorderHandle>;
}

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
}

export default function AudioRecorder({ onChunkReady, onStatusChange, chunkMs = 12000, ref }: Props) {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef = useRef(false);
  const stopResolversRef = useRef<(() => void)[]>([]);

  // Keep latest callbacks without re-creating the recorder
  const onChunkRef = useRef(onChunkReady);
  const onStatusRef = useRef(onStatusChange);
  useEffect(() => {
    onChunkRef.current = onChunkReady;
    onStatusRef.current = onStatusChange;
  });

  const finish = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    onStatusRef.current("idle");
    stopResolversRef.current.forEach((r) => r());
    stopResolversRef.current = [];
  };

  const startRecorder = (stream: MediaStream) => {
    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(parts, { type: recorder.mimeType || "audio/webm" });
      if (blob.size > 500) onChunkRef.current(blob);
      // Each chunk is a complete, independently decodable file, so start a
      // fresh recorder for the next chunk unless the user stopped.
      if (activeRef.current && streamRef.current) startRecorder(streamRef.current);
      else finish();
    };
    recorder.start();
    recorderRef.current = recorder;
  };

  const startRecording = async () => {
    if (activeRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      alert("Audio recording isn't supported here. Use a modern browser on http://localhost.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      activeRef.current = true;
      startRecorder(stream);
      setRecording(true);
      onStatusRef.current("recording");
      intervalRef.current = setInterval(() => {
        const r = recorderRef.current;
        if (r && r.state === "recording") r.stop(); // onstop sends chunk + restarts
      }, chunkMs);
    } catch (err) {
      console.error(err);
      alert("Microphone access denied. Please allow mic access and try again.");
    }
  };

  const stopRecording = (): Promise<void> => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!activeRef.current) return Promise.resolve();
    activeRef.current = false;
    return new Promise<void>((resolve) => {
      stopResolversRef.current.push(resolve);
      const r = recorderRef.current;
      if (r && r.state !== "inactive") r.stop(); // onstop -> finish()
      else if (!r) finish();
      // if r is inactive, a flush's onstop is pending and will call finish()
    });
  };

  useImperativeHandle(ref, () => ({ stop: stopRecording }));

  // Release the microphone if the component unmounts mid-recording
  useEffect(() => {
    return () => {
      activeRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      const r = recorderRef.current;
      if (r) {
        r.onstop = null;
        if (r.state !== "inactive") r.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="flex gap-3 items-center">
      {!recording ? (
        <button
          onClick={startRecording}
          className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-medium transition-colors"
        >
          🎙 Start Recording
        </button>
      ) : (
        <button
          onClick={() => stopRecording()}
          className="bg-red-500 hover:bg-red-600 text-white px-6 py-3 rounded-xl font-medium transition-colors animate-pulse"
        >
          ⏹ Stop Recording
        </button>
      )}
    </div>
  );
}

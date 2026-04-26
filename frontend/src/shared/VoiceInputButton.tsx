// Round E3 — iPhone voice-first.
//
// Tap-and-hold mic button. Records voice → transcribes via the browser's
// SpeechRecognition (iOS Safari: webkitSpeechRecognition; desktop: native).
// On release, the full transcript is passed into the input. The whole
// utterance is processed as one turn — no breaking on pauses, so 60-second
// thoughts stay coherent.
//
// Voice IN only — no voice OUT, no playback, no TTS. (Per the spec: out of
// scope for v1.)
//
// Heuristic for "persistent intent": if the transcript contains phrases
// like "from now on" / "going forward" / "remember to", we set a flag so
// the chat handler knows to surface the summary-back rule for it. Maria's
// prompt then asks "...and I'll remember to apply this to future [context] —
// got it right?" before saving.

import { useEffect, useRef, useState } from 'react';

interface SpeechRecognitionResult { transcript: string; isFinal: boolean }
interface SpeechRecognitionAlternative { transcript: string }
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<{ length: number; isFinal: boolean; 0: SpeechRecognitionAlternative } & SpeechRecognitionResult>;
}
interface SpeechRecognitionErrorEvent extends Event { error: string; message?: string }

declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
  }
}

function isVoiceSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function detectPersistentIntent(transcript: string): string | null {
  const lower = transcript.toLowerCase();
  const phrases = [
    'from now on',
    'going forward',
    'remember to',
    'always do',
    'never do',
    'every time',
    'in the future',
    "don't forget",
  ];
  if (phrases.some((p) => lower.includes(p))) {
    return transcript.trim();
  }
  return null;
}

interface Props {
  onTranscript: (text: string, persistentIntent: string | null) => void;
  disabled?: boolean;
}

export function VoiceInputButton({ onTranscript, disabled }: Props) {
  const [supported] = useState(isVoiceSupported());
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const finalTranscriptRef = useRef<string>('');

  useEffect(() => {
    return () => {
      // Clean shutdown if the component unmounts mid-recording.
      try { recognitionRef.current?.stop(); } catch {}
      recognitionRef.current = null;
    };
  }, []);

  function start() {
    if (!supported || disabled) return;
    setError(null);
    finalTranscriptRef.current = '';
    setInterim('');
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new Ctor();
    recognition.continuous = true;       // long thoughts processed as one turn
    recognition.interimResults = true;
    recognition.lang = (navigator.language || 'en-US');
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = (result as any)[0]?.transcript || '';
        if (result.isFinal) {
          finalTranscriptRef.current = (finalTranscriptRef.current + ' ' + text).trim();
        } else {
          interimText += text;
        }
      }
      setInterim(interimText);
    };
    recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
      // The user may have denied mic permission or the network is offline.
      // Surface a clear message so the user can fall back to keyboard.
      const friendly = e.error === 'not-allowed'
        ? 'Mic access denied — voice is off until you allow it in browser/iOS settings.'
        : e.error === 'no-speech'
          ? "Didn't hear anything — try again."
          : `Voice didn't work (${e.error || 'unknown'}). Use the keyboard instead.`;
      setError(friendly);
      setRecording(false);
      try { recognition.stop(); } catch {}
    };
    recognition.onend = () => {
      setRecording(false);
      const final = finalTranscriptRef.current.trim();
      const interimText = interim.trim();
      const full = [final, interimText].filter(Boolean).join(' ').trim();
      setInterim('');
      if (full) {
        onTranscript(full, detectPersistentIntent(full));
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setRecording(true);
    } catch (err: any) {
      setError(err?.message || 'Could not start voice input.');
    }
  }

  function stop() {
    const r = recognitionRef.current;
    if (!r) return;
    try { r.stop(); } catch {}
    setRecording(false);
  }

  const disabledNow = disabled || !supported;

  return (
    <button
      type="button"
      className={`partner-voice ${recording ? 'is-recording' : ''}`}
      // Pointer events handle both mouse (desktop/iPad) and touch (iPhone).
      // pointerdown to start, pointerup/cancel/leave to stop. The button is
      // tap-and-hold; a quick tap triggers start+stop on the same tap.
      onPointerDown={(e) => { e.preventDefault(); start(); }}
      onPointerUp={() => stop()}
      onPointerLeave={() => recording && stop()}
      onPointerCancel={() => stop()}
      // Keyboard accessibility: hold space when focused.
      onKeyDown={(e) => { if (e.key === ' ' && !recording) { e.preventDefault(); start(); } }}
      onKeyUp={(e) => { if (e.key === ' ' && recording) { e.preventDefault(); stop(); } }}
      disabled={disabledNow}
      aria-label={recording ? 'Recording — release to send' : 'Hold to talk'}
      title={
        !supported
          ? "Voice input isn't supported in this browser. Use the keyboard."
          : recording
            ? 'Recording — release to send'
            : 'Hold to talk. iPhone, iPad, or desktop.'
      }
      style={
        recording
          ? { background: 'rgba(245, 158, 11, 0.18)', borderColor: 'rgba(245, 158, 11, 0.6)' }
          : undefined
      }
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
      {recording && interim && (
        <span style={{ position: 'absolute', bottom: -22, left: 0, right: 0, fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240, pointerEvents: 'none' }}>{interim}</span>
      )}
      {error && (
        <span role="alert" style={{ position: 'absolute', bottom: -22, left: 0, right: 0, fontSize: 11, color: '#b91c1c', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240, pointerEvents: 'none' }}>{error}</span>
      )}
    </button>
  );
}

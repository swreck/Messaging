// Express Flow — chat-first entry route.
//
// Lives at /express on both Maria 2.5 and Maria 3.0 URLs. On the 3.0 URL the
// root "/" redirects here (see App.tsx), so Maria 3 users land on this surface
// by default. On the 2.5 URL it is accessible only to users who type the path
// directly — 2.5 public users see no navigation change.
//
// State machine:
//   greeting   → user types into the input
//   extracting → POST /api/express/extract (thinking dots, "I'm reading what you wrote")
//   reviewing  → InterpretationPreview with real extracted data (inline editable)
//   building   → POST /api/express/commit then poll GET /api/express/status
//                (stage label + progress bar advancing through the silent pipeline)
//   complete   → finished blended draft displayed as a readable document
//   error      → inline message + retry

import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { InterpretationPreview } from './InterpretationPreview';
import type { ExpressInterpretation } from './types';
import { useToast } from '../shared/ToastContext';

type Phase =
  | { name: 'greeting' }
  | { name: 'extracting'; message: string }
  | { name: 'reviewing'; interpretation: ExpressInterpretation }
  | { name: 'building'; jobId: string; stage: string; progress: number; mediumLabel: string }
  | { name: 'complete'; blendedText: string; mediumLabel: string }
  | { name: 'error'; message: string };

interface ExtractResponse {
  interpretation: ExpressInterpretation;
}

interface CommitResponse {
  jobId: string;
  draftId: string;
  offeringId: string;
  audienceId: string;
}

interface StatusResponse {
  jobId: string;
  status: string;
  stage: string;
  progress: number;
  error: string | null;
  draftId: string | null;
  resultStoryId: string | null;
  story: {
    medium: string;
    customName: string;
    blendedText: string;
    chapters: { chapterNum: number; title: string; content: string }[];
  } | null;
}

// Fallback labels if the user's original extracted medium label is not
// available (e.g. page reload during polling). Covers every internal 2.5
// medium key and the Maria 3 pitch_deck addition.
const INTERNAL_MEDIUM_FALLBACK: Record<string, string> = {
  email: 'email',
  blog: 'blog post',
  social: 'social post',
  landing_page: 'landing page',
  in_person: 'talking points',
  press_release: 'press release',
  newsletter: 'newsletter',
  report: 'report',
  pitch_deck: 'pitch deck',
};

export function ExpressEntry() {
  const [phase, setPhase] = useState<Phase>({ name: 'greeting' });
  const [input, setInput] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function handleSend() {
    const message = input.trim();
    if (message.length < 20) return;

    setPhase({ name: 'extracting', message });

    try {
      const res = await api.post<ExtractResponse>('/express/extract', { message });
      setPhase({ name: 'reviewing', interpretation: res.interpretation });
    } catch (err) {
      const errMsg =
        err instanceof Error
          ? err.message
          : 'Something went wrong while reading what you wrote.';
      setPhase({ name: 'error', message: errMsg });
    }
  }

  async function pollStatus(jobId: string, preservedMediumLabel: string) {
    try {
      const status = await api.get<StatusResponse>(`/express/status/${jobId}`);
      if (status.status === 'complete') {
        stopPolling();
        const blendedText = status.story?.blendedText || '';
        // Prefer the user's original extracted medium label. Fall back to the
        // internal 2.5 medium key if that somehow got lost.
        const mediumLabel =
          preservedMediumLabel ||
          (status.story
            ? INTERNAL_MEDIUM_FALLBACK[status.story.medium] || status.story.customName
            : 'first draft');
        setPhase({ name: 'complete', blendedText, mediumLabel });
      } else if (status.status === 'error') {
        stopPolling();
        setPhase({
          name: 'error',
          message: status.error || 'Something went wrong while building your draft.',
        });
      } else {
        setPhase({
          name: 'building',
          jobId,
          stage: status.stage || 'Working on it',
          progress: status.progress || 0,
          mediumLabel: preservedMediumLabel,
        });
      }
    } catch (err) {
      // Transient polling errors — log and keep going. The next tick will retry.
      console.error('[ExpressEntry] Poll error:', err);
    }
  }

  async function handleConfirm(interpretation: ExpressInterpretation) {
    // Preserve the user's original medium label. The backend translates it to
    // an internal 2.5 key when committing, but the user should see the words
    // they chose in the preview ("pitch deck", not "landing page").
    const mediumLabel = interpretation.primaryMedium.value || 'first draft';

    setPhase({
      name: 'building',
      jobId: '',
      stage: 'Setting things up',
      progress: 3,
      mediumLabel,
    });

    try {
      const res = await api.post<CommitResponse>('/express/commit', { interpretation });
      setPhase({
        name: 'building',
        jobId: res.jobId,
        stage: 'Setting things up',
        progress: 5,
        mediumLabel,
      });

      // Start polling. The pipeline runs for several minutes.
      pollRef.current = setInterval(() => {
        pollStatus(res.jobId, mediumLabel);
      }, 2500);

      // Kick off one immediate poll so the stage label updates quickly.
      pollStatus(res.jobId, mediumLabel);
    } catch (err) {
      stopPolling();
      const errMsg =
        err instanceof Error
          ? err.message
          : 'Something went wrong while setting up your draft.';
      setPhase({ name: 'error', message: errMsg });
    }
  }

  function handleSwitchToWizard(_interpretation: ExpressInterpretation) {
    // Full step-by-step wizard handoff lands in a later slice. For now,
    // acknowledge the request and keep the user in Express mode.
    showToast(
      "Step-by-step mode is coming soon. For now, 'Looks right' will put together a first draft you can edit.",
    );
  }

  function handleReset() {
    stopPolling();
    setPhase({ name: 'greeting' });
    setInput('');
  }

  function handleCopy(text: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          showToast('Copied. Paste it wherever you need it.');
        })
        .catch(() => {
          showToast('Could not copy automatically — select the text and copy it manually.');
        });
    }
  }

  // ─── Render ─────────────────────────────────────────

  if (phase.name === 'greeting') {
    const canSend = input.trim().length >= 20;
    return (
      <div className="express-entry">
        <div className="express-entry-greeting">
          <h1 className="express-entry-title">Hi, I'm Maria.</h1>
          <p className="express-entry-subtitle">
            I help people communicate more effectively about what they do — emails, pitch
            narratives, talking points, landing pages, whatever you need. Tell me a little
            about your work and what you need first.
          </p>
        </div>

        <div className="express-entry-input">
          <textarea
            className="express-entry-textarea"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="What do you do, who are you writing to, and what do you need first?"
            rows={8}
            autoFocus
          />
          <div className="express-entry-actions">
            <button
              type="button"
              className="btn btn-primary express-entry-send"
              onClick={handleSend}
              disabled={!canSend}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.name === 'extracting') {
    return (
      <div className="express-entry">
        <div className="express-entry-message-sent">
          <p className="express-entry-user-bubble">{phase.message}</p>
        </div>
        <div className="express-entry-thinking">
          <div className="express-entry-thinking-dot" />
          <div className="express-entry-thinking-dot" />
          <div className="express-entry-thinking-dot" />
          <p>I'm reading what you wrote.</p>
        </div>
      </div>
    );
  }

  if (phase.name === 'reviewing') {
    return (
      <div className="express-entry express-entry-reviewing">
        <InterpretationPreview
          initial={phase.interpretation}
          onConfirm={handleConfirm}
          onSwitchToWizard={handleSwitchToWizard}
        />
      </div>
    );
  }

  if (phase.name === 'building') {
    const pct = Math.max(3, Math.min(100, phase.progress));
    return (
      <div className="express-entry">
        <div className="express-entry-building">
          <h2 className="express-entry-building-title">
            I'll have a first draft for you in a few minutes.
          </h2>
          <div className="express-entry-progress-bar" aria-hidden="true">
            <div
              className="express-entry-progress-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="express-entry-stage">{phase.stage}</p>
        </div>
      </div>
    );
  }

  if (phase.name === 'complete') {
    const paragraphs = phase.blendedText
      .split(/\n\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    return (
      <div className="express-entry">
        <div className="express-entry-complete">
          <p className="express-entry-complete-intro">
            Here's a first draft of your {phase.mediumLabel}. Read it, change anything that
            doesn't sound like you, then copy it wherever you need it.
          </p>
          <div className="express-entry-draft">
            {paragraphs.length === 0 ? (
              <p>(The draft came back empty. Try again with a bit more detail.)</p>
            ) : (
              paragraphs.map((para, i) => <p key={i}>{para}</p>)
            )}
          </div>
          <div className="express-entry-complete-actions">
            <button
              type="button"
              className="btn"
              onClick={() => handleCopy(phase.blendedText)}
            >
              Copy
            </button>
            <button type="button" className="btn" onClick={handleReset}>
              Start something else
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.name === 'error') {
    return (
      <div className="express-entry">
        <div className="express-entry-error">
          <p>{phase.message}</p>
          <button type="button" className="btn" onClick={handleReset}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return null;
}

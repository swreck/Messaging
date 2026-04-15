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
import { useAuth } from '../auth/AuthContext';
import { useWorkspace } from '../shared/WorkspaceContext';

// Maria 3 runs this route without the 2.5 Layout wrapper (see App.tsx). In
// that standalone mode we render our own minimal chrome so the page doesn't
// feel nav-less. On 2.5 URLs, Layout still wraps ExpressEntry, so the chrome
// is hidden to avoid a duplicate header.
function isMariaThreeHostname(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return (
    h.includes('mariamessaging3') ||
    h.includes('maria-messaging-3') ||
    h.includes('maria3.')
  );
}

function Maria3Chrome() {
  const { user, logout } = useAuth();
  const { activeWorkspace } = useWorkspace();
  return (
    <header className="express-chrome">
      <div className="express-chrome-brand">Maria</div>
      <nav className="express-chrome-nav">
        <a className="express-chrome-nav-link" href="/three-tiers">My work</a>
      </nav>
      <div className="express-chrome-right">
        {activeWorkspace && (
          <span className="express-chrome-workspace">{activeWorkspace.name}</span>
        )}
        {user && (
          <>
            <span className="express-chrome-user">{user.username}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={logout}
            >
              Sign Out
            </button>
          </>
        )}
      </div>
    </header>
  );
}

interface DraftVariant {
  storyId: string;
  audienceName: string;
  blendedText: string;
}

type Phase =
  | { name: 'greeting' }
  | { name: 'extracting'; message: string }
  | { name: 'reviewing'; interpretation: ExpressInterpretation }
  | { name: 'building'; jobId: string; stage: string; progress: number; mediumLabel: string }
  | { name: 'complete'; blendedText: string; mediumLabel: string; variants: DraftVariant[]; activeVariant: number }
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
  variantCount: number;
  variants: {
    storyId: string;
    audienceName: string;
    medium: string;
    customName: string;
    blendedText: string;
  }[];
  story: {
    medium: string;
    customName: string;
    blendedText: string;
    chapters: { chapterNum: number; title: string; content: string }[];
  } | null;
}

// Variant tab labels need to fit inside ~320px of tab width without
// truncating the distinguishing word. Audience names coming from the
// extractor can be long ("Compliance officer at a regional or community
// bank", "Founding Members (eleven members, members since 1987)"), so
// trim them to the first meaningful phrase: split on the first of
//   — ( : , "at" "for" "who" "with"
// and cap at 28 characters. Falls back to the raw name if the trim
// produces an empty string.
function shortenAudienceLabel(raw: string): string {
  if (!raw) return 'Draft';
  const trimmed = raw.trim();
  if (trimmed.length <= 28) return trimmed;
  // Split on the first separator that gives a reasonable prefix.
  const separators = [' — ', ' – ', ' - ', ' (', ':', ',', ' at ', ' for ', ' who ', ' with '];
  let best = trimmed;
  for (const sep of separators) {
    const idx = trimmed.indexOf(sep);
    if (idx > 4 && idx < best.length) {
      best = trimmed.slice(0, idx).trim();
    }
  }
  if (best.length <= 28) return best;
  // Last resort: truncate to 26 chars + ellipsis
  return best.slice(0, 26).trim() + '…';
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
  const standalone = isMariaThreeHostname();

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
        // Variant-aware completion. When the pipeline produced multiple
        // audience variants, show them as tabs. When there's only one, the
        // variants array collapses to a single element and the UI renders
        // exactly as before.
        const rawVariants = status.variants && status.variants.length > 0
          ? status.variants
          : status.story
            ? [
                {
                  storyId: status.resultStoryId || '',
                  audienceName: 'Audience',
                  medium: status.story.medium,
                  customName: status.story.customName,
                  blendedText: status.story.blendedText,
                },
              ]
            : [];
        const variants: DraftVariant[] = rawVariants.map(v => ({
          storyId: v.storyId,
          audienceName: v.audienceName,
          blendedText: v.blendedText,
        }));
        const blendedText = variants[0]?.blendedText || '';
        const mediumLabel =
          preservedMediumLabel ||
          (status.story
            ? INTERNAL_MEDIUM_FALLBACK[status.story.medium] || status.story.customName
            : 'first draft');
        setPhase({
          name: 'complete',
          blendedText,
          mediumLabel,
          variants,
          activeVariant: 0,
        });
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

  async function handleSwitchToWizard(interpretation: ExpressInterpretation) {
    // Commit the interpretation (offering, audience, priorities) as Three
    // Tier DB rows and drop the user into the wizard at Step 4 — where
    // actual new work begins. The wizard lets them navigate backward to
    // Steps 1-3 to review anything they wrote in the Express entry.
    showToast('Opening step-by-step mode.');
    try {
      const res = await api.post<{ draftId: string }>(
        '/express/commit-for-wizard',
        { interpretation },
      );
      window.location.href = `/three-tier/${res.draftId}`;
    } catch (err) {
      const errMsg =
        err instanceof Error
          ? err.message
          : 'Could not open step-by-step mode.';
      setPhase({ name: 'error', message: errMsg });
    }
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

  function wrap(children: React.ReactNode) {
    if (!standalone) return children;
    return (
      <div className="express-shell">
        <Maria3Chrome />
        <div className="express-shell-main">{children}</div>
      </div>
    );
  }

  if (phase.name === 'greeting') {
    const canSend = input.trim().length >= 20;
    return wrap(
      <div className="express-entry">
        <div className="express-entry-greeting">
          <h1 className="express-entry-title">Hi, I'm Maria.</h1>
          <p className="express-entry-subtitle">
            I help people communicate more effectively about what they do — emails, pitch
            narratives, talking points, landing pages, whatever you need. Tell me a little
            about your work and what you need me to write.
          </p>
        </div>

        <div className="express-entry-input">
          <textarea
            className="express-entry-textarea"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="What do you do, who are you writing to, and what do you need me to write?"
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
      </div>,
    );
  }

  if (phase.name === 'extracting') {
    // Show a compact preview of what the user sent — never the full message.
    // A 1500-character input rendered verbatim pushes Maria's thinking
    // indicator below the fold, which makes the send feel unanswered.
    const previewLimit = 220;
    const preview =
      phase.message.length > previewLimit
        ? phase.message.slice(0, previewLimit).trim() + '…'
        : phase.message;
    return wrap(
      <div className="express-entry">
        <div className="express-entry-message-sent">
          <p className="express-entry-user-bubble">{preview}</p>
        </div>
        <div className="express-entry-thinking">
          <div className="express-entry-thinking-dot" />
          <div className="express-entry-thinking-dot" />
          <div className="express-entry-thinking-dot" />
          <p>I'm reading what you wrote.</p>
        </div>
      </div>,
    );
  }

  if (phase.name === 'reviewing') {
    return wrap(
      <div className="express-entry express-entry-reviewing">
        <InterpretationPreview
          initial={phase.interpretation}
          onConfirm={handleConfirm}
          onSwitchToWizard={handleSwitchToWizard}
        />
      </div>,
    );
  }

  if (phase.name === 'building') {
    const pct = Math.max(3, Math.min(100, phase.progress));
    return wrap(
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
      </div>,
    );
  }

  if (phase.name === 'complete') {
    // Pick the active variant (or the single draft if only one was generated)
    // and render the blended text as paragraphs. Multi-variant completions
    // show a tab bar above the draft so the user can flip between audiences.
    const variants = phase.variants.length > 0
      ? phase.variants
      : [{ storyId: '', audienceName: 'Audience', blendedText: phase.blendedText }];
    const active = variants[phase.activeVariant] || variants[0];
    const paragraphs = active.blendedText
      .split(/\n\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    const setActiveVariant = (index: number) => {
      setPhase(curr => {
        if (curr.name !== 'complete') return curr;
        return { ...curr, activeVariant: index };
      });
    };

    return wrap(
      <div className="express-entry">
        <div className="express-entry-complete">
          <p className="express-entry-complete-intro">
            {variants.length > 1 ? (
              <>
                Here are your {variants.length} first drafts — one per audience. Switch
                between them with the tabs, change anything that doesn't sound like you,
                then copy whichever one you need.
              </>
            ) : (
              <>
                Here's a first draft of your {phase.mediumLabel}. Read it, change anything
                that doesn't sound like you, then copy it wherever you need it.
              </>
            )}
          </p>

          {variants.length > 1 && (
            <div className="express-variant-tabs" role="tablist">
              {variants.map((v, i) => (
                <button
                  key={v.storyId || i}
                  type="button"
                  role="tab"
                  aria-selected={i === phase.activeVariant}
                  className={`express-variant-tab${
                    i === phase.activeVariant ? ' express-variant-tab-active' : ''
                  }`}
                  onClick={() => setActiveVariant(i)}
                  title={v.audienceName}
                >
                  {shortenAudienceLabel(v.audienceName) || `Draft ${i + 1}`}
                </button>
              ))}
            </div>
          )}

          <div className="express-entry-draft">
            {variants.length > 1 && active.audienceName && (
              <p className="express-variant-audience">
                <span>Writing to:</span> {active.audienceName}
              </p>
            )}
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
              onClick={() => handleCopy(active.blendedText)}
            >
              Copy
            </button>
            <button type="button" className="btn" onClick={handleReset}>
              Start something else
            </button>
          </div>
        </div>
      </div>,
    );
  }

  if (phase.name === 'error') {
    return wrap(
      <div className="express-entry">
        <div className="express-entry-error">
          <p>{phase.message}</p>
          <button type="button" className="btn" onClick={handleReset}>
            Try again
          </button>
        </div>
      </div>,
    );
  }

  return null;
}

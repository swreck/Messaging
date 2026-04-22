import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useWorkspace } from '../shared/WorkspaceContext';
import { useToast } from '../shared/ToastContext';
import { useGuidedSessionContext } from './GuidedSessionContext';
import { ProcessBar } from './ProcessBar';
import { InputConfirmationCard } from './InputConfirmationCard';
import { FoundationCard } from './FoundationCard';
import { DraftView } from './DraftView';
import type {
  EnrichedInterpretation,
  FoundationData,
  GuidedPhase,
  GuidedStage,
  GuidedMedium,
  ChatMessage,
} from './types';

let msgId = 0;
function nextId(): string {
  return `msg-${++msgId}`;
}

const MEDIUM_OPTIONS: { value: GuidedMedium; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'pitch deck', label: 'Pitch deck' },
  { value: 'one-pager', label: 'One-pager' },
  { value: 'blog post', label: 'Blog post' },
  { value: 'talking points', label: 'Talking points' },
  { value: 'landing page', label: 'Landing page' },
  { value: 'press release', label: 'Press release' },
  { value: 'newsletter', label: 'Newsletter' },
  { value: 'report', label: 'Report' },
];

function shortAudienceName(fullName: string): string {
  const stripped = fullName.replace(/\s*\(.*?\)\s*/g, '').trim();
  if (/^(the |a )/i.test(stripped)) return stripped;
  return stripped;
}

function isMariaThreeHostname(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h.includes('mariamessaging3') || h.includes('maria-messaging-3') || h.includes('maria3.');
}

export interface GuidedFlowProps {
  /**
   * 'full' (default): renders as a full-page experience with hero header, its own chrome.
   *   Used when GuidedFlow stands alone on a dedicated URL.
   * 'panel': renders inside the MariaPartner panel. Drops the outer header + standalone chrome;
   *   parent panel provides frame, sizing, close button.
   */
  mode?: 'full' | 'panel';
  /**
   * Panel-mode only: called when the user clicks "Chat with Maria instead" — lets the parent
   * (MariaPartner) switch the panel body back to assistant chat without destroying the guided session.
   */
  onSwitchToAssistant?: () => void;
}

export function GuidedFlow({ mode = 'full', onSwitchToAssistant }: GuidedFlowProps = {}) {
  const [phase, setPhase] = useState<GuidedPhase>('greeting');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const latestDraftRef = useRef<string>('');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [completedStages, setCompletedStages] = useState<Set<GuidedStage>>(new Set());

  // Multi-turn conversational intake
  const [intakeStep, setIntakeStep] = useState(0);
  const intakeAnswers = useRef<{ offering: string; audience: string; situation: string }>({
    offering: '', audience: '', situation: '',
  });

  // Maria-led review walk-through
  const [, setReviewStep] = useState(0);

  // Backlog of dismissed observations Maria can resurface
  const backlog = useRef<{ text: string; phase: string }[]>([]);

  // Navigation offer — tracks a pending "Want me to take you there?" from Maria
  const [pendingNavTarget, setPendingNavTarget] = useState<string | null>(null);

  // Foundation has Maria suggestions (for live evaluation highlight)
  const [foundationHasSuggestions, setFoundationHasSuggestions] = useState(false);

  // Guidance density — track Maria's message count, ask after ~5
  const mariaMessageCount = useRef(0);
  const [askedAboutLength, setAskedAboutLength] = useState(false);

  // Persisted data across phases
  const [interpretation, setInterpretation] = useState<EnrichedInterpretation | null>(null);
  const [foundation, setFoundation] = useState<FoundationData | null>(null);
  const [situation, setSituation] = useState('');
  const [, setDraftJobId] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const generatingRef = useRef(false);
  const { user, logout } = useAuth();
  const { activeWorkspace } = useWorkspace();
  const { showToast } = useToast();
  const navigate = useNavigate();
  // Standalone = full-page chrome (hero header, sign-out, workspace label).
  // When embedded in a panel, parent provides the chrome and we suppress our own.
  const standalone = mode === 'full' && isMariaThreeHostname();
  const { session, isLoading: sessionLoading, saveSession } = useGuidedSessionContext();
  const restoredRef = useRef(false);
  // Tracks whether the save effect has fired at least once AFTER restore.
  // Skipping the first fire is critical: on a fresh mount, the save effect runs
  // before React commits setMessages from the restore effect, so it would
  // optimistically overwrite context.session.messages with the empty initial value —
  // causing MariaPartner to see hasActiveGuidedSession=false and unmount us.
  const skipNextSaveRef = useRef(false);

  useEffect(() => {
    if (!session || restoredRef.current || sessionLoading) return;
    if (session.phase === 'greeting' && session.messages.length === 0) {
      restoredRef.current = true;
      return;
    }
    restoredRef.current = true;
    // When there's real session state to restore, the save effect is about to
    // fire with stale (empty) local state. Mark it to be skipped once.
    skipNextSaveRef.current = true;
    setPhase(session.phase as GuidedPhase);
    setMessages(session.messages);
    setCompletedStages(new Set(session.completedStages as GuidedStage[]));
    if (session.interpretation) setInterpretation(session.interpretation);
    if (session.foundation) setFoundation(session.foundation);
    if (session.situation) setSituation(session.situation);
    if (session.lastDraftText) latestDraftRef.current = session.lastDraftText;
    if (session.intakeAnswers) {
      intakeAnswers.current = session.intakeAnswers;
      const steps = [session.intakeAnswers.offering, session.intakeAnswers.audience, session.intakeAnswers.situation];
      setIntakeStep(steps.filter(Boolean).length);
    }
    if (session.backlog) backlog.current = session.backlog;
  }, [session, sessionLoading]);

  useEffect(() => {
    if (!restoredRef.current) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    saveSession({
      phase,
      messages,
      completedStages: Array.from(completedStages),
      interpretation,
      foundation,
      situation,
      lastDraftText: latestDraftRef.current || null,
    });
  }, [phase, messages, interpretation, foundation, situation, completedStages]);

  // Auto-scroll to bottom when messages change (slight delay for card rendering)
  useEffect(() => {
    const timer = setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100)
    return () => clearTimeout(timer);
  }, [messages]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function addMessage(msg: Omit<ChatMessage, 'id'>): string {
    const id = nextId();
    setMessages(prev => [...prev, { ...msg, id }]);
    if (msg.type === 'maria' && msg.text) {
      mariaMessageCount.current++;
      if (mariaMessageCount.current === 6 && !askedAboutLength) {
        setAskedAboutLength(true);
        setTimeout(() => {
          const densityId = nextId();
          setMessages(prev => [...prev, {
            id: densityId,
            type: 'maria',
            text: "Quick question — are my messages about the right length? I can be shorter if you prefer. Just let me know.",
          }]);
        }, 1500);
      }
    }
    return id;
  }

  function updateMessage(id: string, updates: Partial<ChatMessage>) {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m));
  }

  function removeMessage(id: string) {
    setMessages(prev => prev.filter(m => m.id !== id));
  }

  // ── Current stage derived from phase ─────────────
  function currentStage(): GuidedStage {
    switch (phase) {
      case 'greeting':
      case 'extracting':
      case 'confirming_inputs':
        return 'inputs';
      case 'generating_foundation':
      case 'reviewing_foundation':
        return 'foundation';
      case 'choosing_format':
      case 'generating_draft':
      case 'reviewing_draft':
      case 'complete':
        return 'deliverable';
    }
  }

  // ── Conversational intake — Maria leads, one question at a time ──
  function handleIntakeReply() {
    const domValue = textareaRef.current?.value || '';
    const text = (input || domValue).trim();
    if (!text) return;

    addMessage({ type: 'user', text });
    setInput('');

    if (intakeStep === 0) {
      intakeAnswers.current.offering = text;

      if (text.split(/\s+/).length <= 5 && !intakeAnswers.current.offering.includes('\n')) {
        intakeAnswers.current.offering = text;
        addMessage({ type: 'maria', text: `Got it — ${text}. Can you tell me a bit more? What does someone actually get from working with you?` });
        return;
      }
      if (intakeAnswers.current.offering && !intakeAnswers.current.offering.includes(text)) {
        intakeAnswers.current.offering += '. ' + text;
      }

      const hasUrl = /\b(www\.|https?:\/\/|\.com|\.io|\.org|\.net)\b/i.test(text);
      if (hasUrl) {
        const urlMatch = text.match(/(https?:\/\/[^\s]+|www\.[^\s]+|\S+\.(com|io|org|net)[^\s]*)/i);
        if (urlMatch) {
          addMessage({ type: 'maria', text: `I see a website in what you wrote — I'm going to read it to learn more about your offering. This helps me identify what makes you different. I'll combine what I find with what you told me, then ask about your audience.` });
          api.post<{ findings: string | null }>('/research/website', { url: urlMatch[0] })
            .then(r => {
              if (r.findings) intakeAnswers.current.offering += '\n\nFrom website:\n' + r.findings;
            })
            .catch(() => {});
        }
      }

      runSmartIntake(text);
    } else if (intakeStep === 1) {
      const combined = intakeAnswers.current.offering + '. The audience is: ' + text;
      intakeAnswers.current.audience = text;
      runSmartIntake(combined);
    } else if (intakeStep === 2) {
      intakeAnswers.current.situation = text;
      const combined = [
        intakeAnswers.current.offering,
        `The audience is: ${intakeAnswers.current.audience}`,
        `The situation: ${intakeAnswers.current.situation}`,
      ].join('. ');
      runExtraction(combined);
    }
  }

  // ── Smart intake: send to AI, check what's missing, ask only what's needed ──
  async function runSmartIntake(textSoFar: string) {
    const thinkingId = addMessage({ type: 'thinking' });

    try {
      const res = await api.post<{ interpretation: EnrichedInterpretation }>(
        '/express/extract',
        { message: textSoFar },
      );
      removeMessage(thinkingId);

      const interp = res.interpretation;
      const hasAudience = interp.audiences.length > 0 && interp.audiences[0].name && interp.audiences[0].source === 'stated';
      const hasDiffs = interp.offering.differentiators.filter(d => d.text.trim()).length > 0;

      if (hasAudience && hasDiffs) {
        setInterpretation(interp);
        setSituation(interp.situation || '');

        const audName = shortAudienceName(interp.audiences[0]?.name || 'your audience');
        const diffCount = interp.offering.differentiators.filter(d => d.text.trim()).length;
        const prioCount = interp.audiences[0]?.priorities.filter(p => p.text.trim()).length || 0;
        const hasDetailedAud = interp.audiences[0]?.description && interp.audiences[0].description.length > 20;
        const hasProofInInput = /pilot|customer|geisinger|client|partner|case study/i.test(textSoFar);

        let ackMsg = `I found ${diffCount} differentiator${diffCount !== 1 ? 's' : ''} and ${prioCount} priorit${prioCount !== 1 ? 'ies' : 'y'} for ${audName}.`;

        if (hasDetailedAud && hasProofInInput) {
          ackMsg += ` You gave me a lot to work with — audience context, differentiators, even proof. That's unusual. Most people need several rounds to get here.`;
        } else if (diffCount >= 4) {
          ackMsg += ` You clearly know your offering well.`;
        }

        ackMsg += `\n\nEverything is in the card below. Check it, fix what I got wrong, fill in gaps. After this, I build your foundational message — the structure that connects what you do to what ${audName} cares about. Then we turn that into whatever format you need.`;

        addMessage({ type: 'maria', text: ackMsg });

        addMessage({ type: 'input-card', interpretation: interp });
        setReviewStep(0);
        startGuidedReview(interp);
        setPhase('confirming_inputs');
      } else if (!hasAudience) {
        intakeAnswers.current.offering = textSoFar;
        const diffCount = interp.offering.differentiators.filter(d => d.text.trim()).length;
        addMessage({
          type: 'maria',
          text: diffCount > 0
            ? `I found ${diffCount} thing${diffCount !== 1 ? 's' : ''} that make you different. Now I need to know who you're writing for — the message changes completely depending on the audience. Who are you trying to reach?`
            : `I have a sense of what you do, but I need to know who you're writing for. A message for a CFO is completely different from one for a VP of Engineering. Who are you trying to reach right now?`,
        });
        setIntakeStep(1);
      } else {
        setInterpretation(interp);
        setSituation(interp.situation || '');
        addMessage({ type: 'input-card', interpretation: interp });
        setReviewStep(0);
        startGuidedReview(interp);
        setPhase('confirming_inputs');
      }
    } catch {
      removeMessage(thinkingId);
      addMessage({
        type: 'maria',
        text: "I had trouble making sense of that. Could you tell me more? I work best when I know what you offer and what makes it valuable — even a couple of sentences gives me enough to start.",
      });
      setIntakeStep(0);
    }
  }

  // ── Shared extraction logic ─────────────────────
  async function runExtraction(message: string) {
    const thinkingId = addMessage({ type: 'thinking' });
    setPhase('extracting');

    addMessage({ type: 'maria', text: "I have what I need. I'm analyzing your offering and audience now — identifying differentiators, mapping priorities, and checking what's strong and what I'll need your help with. About thirty seconds. Then I'll show you everything for review." });

    const slowTimer = setTimeout(() => {
      updateMessage(thinkingId, { text: 'Reading carefully — this takes a moment with longer descriptions.' });
    }, 8000);

    try {
      const res = await api.post<{ interpretation: EnrichedInterpretation }>(
        '/express/extract',
        { message },
      );
      clearTimeout(slowTimer);
      removeMessage(thinkingId);

      const interp = res.interpretation;
      setInterpretation(interp);
      setSituation(interp.situation || '');

      addMessage({ type: 'input-card', interpretation: interp });
      setReviewStep(0);
      startGuidedReview(interp);

      setPhase('confirming_inputs');
    } catch (err) {
      clearTimeout(slowTimer);
      removeMessage(thinkingId);
      console.error('[GuidedFlow] Extraction error:', err);
      addMessage({
        type: 'maria',
        text: "Something went wrong on my end — sorry. Could you try again?",
      });
      setPhase('greeting');
      setIntakeStep(0);
    }
  }

  // ── Phase: Confirming Inputs → Generating Foundation ──
  async function handleConfirmInputs(edited: EnrichedInterpretation) {
    setInterpretation(edited);
    setCompletedStages(prev => new Set([...prev, 'inputs']));

    const audName = edited.audiences[0]?.name || 'your audience';
    addMessage({
      type: 'maria',
      text: `Now I'm going to build your foundational message. Here's what happens next:\n\nI take your differentiators and connect each one to ${audName}'s priorities. The result is a structured message with a key statement at the top — the single most important thing ${audName} needs to hear — and supporting statements underneath, each from a different angle: your product, the ROI, your support, and proof from other customers.\n\nThis takes about thirty seconds. When it's done, I'll walk you through it and point out where I'm strong and where I need your help.`,
    });
    const progressId = addMessage({ type: 'progress', stage: 'Connecting what you do to what they care about', progress: 30 });
    setPhase('generating_foundation');

    try {
      const res = await api.post<FoundationData>(
        '/express/build-foundation',
        { interpretation: edited },
      );
      removeMessage(progressId);

      setFoundation(res);

      const audienceFull = edited.audiences[0]?.name || 'your reader';
      const audienceName = shortAudienceName(audienceFull);
      const tier1Text = res.tier1?.text || '';
      const tier2Cols = res.tier2 || [];

      addMessage({ type: 'foundation-card', foundation: res });

      const observations: string[] = [];

      observations.push(`Your key message: "${tier1Text}"\n\nThis connects ${audienceName}'s #1 priority to your strongest differentiator. The test: read it as ${audienceName}. Do they think "I can't ignore this"? Not that they need your product — that they need to ACT on this issue. If it sounds like a brochure, it needs work.`);

      for (const col of tier2Cols) {
        const label = (col.categoryLabel || '').toLowerCase();
        const text = col.text || '';
        const proofs = col.tier3?.filter(b => b.text.trim()) || [];

        if (label.includes('focus') && text.length < 20) {
          observations.push(`The Focus column is weak. This should show your commitment to people like ${audienceName} — not your credentials, but that you're focused on THEIR world.`);
        }
        if (label.includes('roi') && !/\d/.test(text)) {
          observations.push(`Your ROI statement doesn't have a number in it. ${audienceName} thinks in dollars and percentages. "Reduce costs" is vague. "Testing drops from $4,000 to under $1" is a conversation starter. Can you add the math?`);
        }
        if (label.includes('support') && text.length < 20) {
          observations.push(`The Support column is thin. ${audienceName} needs to feel that saying yes won't leave them figuring things out alone. What does your implementation, training, or ongoing support look like?`);
        }
        if ((label.includes('proof') || label.includes('social')) && proofs.length === 0) {
          observations.push(`Your Social Proof column has no proof points. This is where skeptics decide whether to believe you. One named customer, one verifiable outcome, one recognized certification — that's what turns a claim into credibility.`);
        }
        if (proofs.length > 0) {
          const vagueProofs = proofs.filter(p => /better|faster|easier|improved|enhanced|leading/i.test(p.text));
          if (vagueProofs.length > 0) {
            observations.push(`Some proof points use comparative words ("${vagueProofs[0].text.slice(0, 40)}..."). Proof must be VERIFIABLE. Not "faster" — "results in under 1 minute vs. 2-week lab turnaround." A skeptic should be able to check it independently.`);
          }
        }
      }

      let walkthrough = observations.join('\n\n');
      walkthrough += `\n\nClick any text to edit. Tell me what's off and I'll help.`;

      addMessage({ type: 'maria', text: walkthrough });

      setPhase('reviewing_foundation');
    } catch (err) {
      removeMessage(progressId);
      console.error('[GuidedFlow] Foundation error:', err);
      addMessage({ type: 'maria', text: "Something went wrong while I was building the foundation — that's on me, not you. Your inputs are still saved in the card above. Click \"Build my message\" again to retry. If it fails again, try editing the card to simplify — sometimes fewer items helps me focus." });
      setPhase('confirming_inputs');
    }
  }

  // ── Phase: Reviewing Foundation → Choosing Format ──
  function handleConfirmFoundation(_foundation: FoundationData) {
    setCompletedStages(prev => new Set([...prev, 'foundation']));

    const sit = (situation || intakeAnswers.current.situation || '').toLowerCase();
    const fullInput = (intakeAnswers.current.offering + ' ' + sit).toLowerCase();
    let suggestion = '';
    if (/\b(need|want|send|write|build)\b.{0,20}\bemail\b/i.test(fullInput) || /follow.?up email/i.test(fullInput)) {
      suggestion = `You mentioned an email — I'll build that for you.`;
    } else if (/\b(need|want|build)\b.{0,20}\b(talking points|talk track)/i.test(fullInput)) {
      suggestion = `You mentioned talking points — I'll build those for you.`;
    } else if (/\b(need|want|build)\b.{0,20}\b(deck|slides|presentation)/i.test(fullInput)) {
      suggestion = `You mentioned a presentation — I'd suggest a pitch deck narrative. It gives you the story arc for your slides.`;
    } else if (/\b(need|want|build)\b.{0,20}\b(one.?pager|leave.?behind)/i.test(fullInput)) {
      suggestion = `You mentioned a one-pager — I'll build that for you.`;
    } else if (/meeting|call/i.test(sit) && !/email/i.test(fullInput)) {
      suggestion = `You mentioned a meeting — I'd suggest talking points. They give you a structure without scripting every word.`;
    } else if (/presentation|pitch|present/i.test(sit)) {
      suggestion = `You mentioned a presentation — I'd suggest a pitch deck narrative.`;
    }

    let transitionMsg = "Good — your foundation is locked in. Everything I write from here starts from this structure.";
    if (suggestion) {
      transitionMsg += `\n\n${suggestion} You can also pick a different format below if that's not what you need. I also need to know what you want the reader to DO after — schedule a call, approve a budget, reply. The call to action shapes how I close the piece.`;
    } else {
      transitionMsg += `\n\nWhat do you need — an email, talking points, a one-pager? Pick a format below and tell me what the reader should do after reading it. You can come back for more formats from this same foundation.`;
    }

    addMessage({ type: 'maria', text: transitionMsg });
    addMessage({ type: 'format-prompt' });

    setPhase('choosing_format');
  }

  // ── Phase: Choosing Format → Generating Draft ──
  async function handleFormatChosen(medium: string, cta: string) {
    if (!foundation || generatingRef.current) return;
    generatingRef.current = true;

    addMessage({ type: 'user', text: `${medium}. CTA: ${cta}` });
    addMessage({
      type: 'maria',
      text: `Writing your ${medium}. Here's how I build it:\n\nI write in five sections. The opening creates urgency — a truth ${interpretation?.audiences[0]?.name || 'your reader'} already suspects but hasn't acted on. Then your approach, then trust and proof, then a clear next step. Each section has a specific job. I write them separately and blend them into one cohesive piece.\n\nThis takes about two minutes. When it's done, I'll show you the full draft AND the sections broken out so you can see how each one works.`,
    });
    const progressId = addMessage({ type: 'progress', stage: 'Starting', progress: 5 });
    setPhase('generating_draft');

    try {
      const res = await api.post<{ jobId: string; storyId: string }>(
        '/express/build-draft',
        {
          draftId: foundation.draftId,
          medium,
          cta,
          situation,
        },
      );

      setDraftJobId(res.jobId);

      // Start polling
      pollRef.current = setInterval(() => {
        pollDraftStatus(res.jobId, progressId, medium);
      }, 2500);

      // Immediate first poll
      pollDraftStatus(res.jobId, progressId, medium);
    } catch (err) {
      removeMessage(progressId);
      console.error('[GuidedFlow] Draft build error:', err);
      addMessage({ type: 'maria', text: "I had trouble starting the draft — something went wrong on my end. Your foundation is still intact. Try selecting the format and clicking \"Write it\" again. The foundation doesn't need to be rebuilt — I'll use what you already approved." });
      setPhase('choosing_format');
      generatingRef.current = false;
    }
  }

  // ── Draft polling ────────────────────────────────
  const pollDraftStatus = useCallback(async (jobId: string, progressId: string, medium: string) => {
    try {
      const status = await api.get<{
        status: string;
        stage: string;
        progress: number;
        error: string | null;
        story: {
          blendedText: string;
          chapters: { chapterNum: number; title: string; content: string }[];
        } | null;
      }>(`/express/status/${jobId}`);

      if (status.status === 'complete') {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        removeMessage(progressId);

        const blendedText = status.story?.blendedText || '';
        const chapters = status.story?.chapters || [];
        const audienceName = interpretation?.audiences[0]?.name || 'your reader';

        latestDraftRef.current = blendedText;
        addMessage({
          type: 'draft-view',
          draft: { blendedText, medium, chapters },
        });
        const draftIntroId = addMessage({
          type: 'maria',
          text: `Here's your first draft — ${/^[aeiou]/i.test(medium) ? 'an' : 'a'} ${medium} for ${audienceName}.\n\nThis is a FIRST DRAFT, not a deliverable. Your edits are what make it something you'd put your name on.\n\nThree things to check:\n\n1. THE OPENING. Read the first two sentences as your reader. Do they think "I need to do something about this"? If the opening tells them something they already know, it fails. The opening should name a truth they've been avoiding.\n\n2. THE VOICE. Read any sentence out loud. Does it sound like you talking to a smart colleague at a small table? If any sentence sounds like marketing copy, a consultant, or AI — tell me which one and how you'd actually say it.\n\n3. THE PROOF. If I mention a customer, a number, or a result — can you verify it? I may have inferred things that aren't accurate. Every fact needs to be something YOU can stand behind.\n\nClick "See sections" below the draft to see how each part works. Tell me what to fix.`,
        });
        setTimeout(() => {
          document.getElementById(draftIntroId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 200);

        setCompletedStages(prev => new Set([...prev, 'deliverable']));
        setPhase('complete');
        generatingRef.current = false;

        setTimeout(() => {
          const styleId = nextId();
          setMessages(prev => [...prev, {
            id: styleId,
            type: 'maria',
            text: "One more thing — I can learn your writing style so future drafts sound more like you. Tell me about your style in the chat anytime, or go to Settings where I can interview you about how you like to communicate. The more I know, the closer my first drafts will be to how you'd actually write it.",
          }]);
        }, 5000);
      } else if (status.status === 'error') {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        removeMessage(progressId);
        addMessage({ type: 'maria', text: status.error || 'Something went wrong while writing the draft.' });
        setPhase('choosing_format');
        generatingRef.current = false;
      } else {
        const stageDescriptions: Record<string, string> = {
          'Writing section 1 of 5': 'Writing the opening — the truth your reader has been avoiding',
          'Writing section 2 of 5': 'Building your approach — what changes in their world',
          'Writing section 3 of 5': 'Adding trust — why saying yes is safe',
          'Writing section 4 of 5': 'Adding proof — evidence from people who made this choice',
          'Writing section 5 of 5': 'Writing the close — what they can do this week',
          'Blending chapters': 'Blending sections into one cohesive piece',
        };
        const humanStage = stageDescriptions[status.stage] || status.stage || 'Working on it';
        updateMessage(progressId, {
          stage: humanStage,
          progress: status.progress || 5,
        });
      }
    } catch {
      // Transient polling error — keep going
    }
  }, [interpretation]);

  // ── Maria-led guided review of extracted inputs ──
  function startGuidedReview(interp: EnrichedInterpretation) {
    const diffs = interp.offering.differentiators.filter(d => d.text.trim());
    const aud = interp.audiences[0];
    const prios = aud?.priorities.filter(p => p.text.trim()) || [];
    const audName = shortAudienceName(aud?.name || 'your audience');

    const thinMFs = diffs.filter(d => !d.motivatingFactor?.trim());
    const thinDrivers = prios.filter(p => !p.driver?.trim());
    const inferredDiffs = diffs.filter(d => d.source === 'inferred');
    const inferredPrios = prios.filter(p => p.source === 'inferred');

    const observations: string[] = [];

    if (inferredDiffs.length > 0 || inferredPrios.length > 0) {
      observations.push(`Items with a rose border are ones I drafted — I wrote the first version from what you told me. Check that they match what you'd actually say.`);
    }

    for (const d of diffs.slice(0, 3)) {
      const lowerText = d.text.toLowerCase();
      const looksLikeFeature = /\b(provides|enables|supports|includes|offers|delivers|uses|runs|has)\b/i.test(lowerText) && !/\b(only|unique|first|no one|cannot|competitors)\b/i.test(lowerText);
      if (looksLikeFeature) {
        observations.push(`"${d.text.slice(0, 60)}${d.text.length > 60 ? '...' : ''}" describes what your product does — but ${audName} doesn't care about features. They care about what changes in THEIR world. What can you do that nobody else can? That's the differentiator.`);
        break;
      }
    }

    if (thinMFs.length > 0) {
      const example = thinMFs[0].text;
      observations.push(`"${example.slice(0, 50)}${example.length > 50 ? '...' : ''}" — I can see what this IS, but not why ${audName} would CRAVE it. The craving is the human consequence. If your AI runs on existing equipment, the craving isn't "uses existing hardware" — it's "no capital request, no procurement nightmare, no 18-month IT project." What does this differentiator actually MEAN for this person's life?`);
    }

    if (thinDrivers.length > 0) {
      const example = thinDrivers[0].text;
      observations.push(`"${example.slice(0, 50)}${example.length > 50 ? '...' : ''}" is a real priority, but I don't know why THIS ${audName} cares about it personally. Every CFO cares about costs. But is THIS CFO's board cutting budgets? Did they just lose a vendor? The driver is what makes ${audName} feel like you understand THEM, not just their role.`);
    }

    const hasROI = diffs.some(d => /cost|price|roi|sav|margin|revenue|budget|\$|%/i.test(d.text + (d.motivatingFactor || '')));
    const hasProof = diffs.some(d => /customer|client|partner|pilot|deploy|case|testimonial/i.test(d.text + (d.motivatingFactor || '')));

    if (!hasROI) {
      observations.push(`I don't see a financial story. ${audName} will ask themselves: "what is this worth to me?" If you don't answer that, they'll estimate — and they'll estimate low. Even a rough range like "hospitals using this save between $500K and $2M annually" gives them something to anchor on.`);
    }

    if (!hasProof) {
      observations.push(`I don't see proof from anyone who's already done this. ${audName} is thinking: "has this actually worked for someone like me?" One named customer, one verifiable outcome — that's the difference between a pitch and a credible recommendation. Can you name one?`);
    }

    if (prios.length > 0) {
      observations.push(`I'm leading with "${prios[0].text.slice(0, 50)}${prios[0].text.length > 50 ? '...' : ''}" as ${audName}'s top priority. Everything in the final message opens with this. The test: if ${audName} heard this priority stated plainly, would they think "yes, that's exactly what I'm dealing with"? If they'd shrug, it's the wrong #1. Drag to reorder.`);
    }

    const hasROISignal = diffs.some(d => /\d|cost|price|roi|sav|margin|revenue|budget|\$|%|reduce|improve|increase/i.test(d.text + (d.motivatingFactor || ''))) || prios.some(p => /\d|cost|budget|margin|revenue/i.test(p.text + (p.driver || '')));
    const hasCompetitiveEdge = diffs.some(d => /only|unique|first|no one|cannot|don't|patent|exclusive|proprietary/i.test(d.text)) || diffs.length >= 3;
    const readyToMap = diffs.length >= 2 && prios.length >= 2 && thinMFs.length <= 1 && thinDrivers.length <= 1;

    const gentleQuestions: string[] = [];
    if (!hasROISignal) {
      gentleQuestions.push(`Do you have a number that shows measurable results? Even a rough one — "clients typically see a 30% improvement" or "one customer saved $200K." A number makes the message concrete instead of aspirational.`);
    }
    if (!hasCompetitiveEdge) {
      gentleQuestions.push(`When you tell a friend what makes your offering better than someone else's, what would you mention? That's often the real differentiator — the thing you'd say casually that you haven't said formally yet.`);
    }

    let reviewMsg: string;

    if (readyToMap && gentleQuestions.length === 0 && observations.length === 0) {
      reviewMsg = `I have what I need — ${diffs.length} differentiators, ${prios.length} priorities, and depth behind each one. Take a quick look at the card to make sure it matches what you know, then click "Build my message."`;
    } else if (readyToMap) {
      const topConcern = gentleQuestions.length > 0 ? gentleQuestions[0] : observations[0];
      const allRemaining = [...gentleQuestions.slice(1), ...observations];
      reviewMsg = `I can build from this — the core is solid. One thing that would make it stronger:\n\n${topConcern}`;
      if (allRemaining.length > 0) {
        reviewMsg += `\n\nI have ${allRemaining.length} other thought${allRemaining.length > 1 ? 's' : ''} — ask me "what else?" when you're ready.`;
        backlog.current = allRemaining.map(t => ({ text: t, phase: 'inputs' }));
      }
      reviewMsg += `\n\nAddress this now or click "Build my message" and we'll work with what we have.`;
    } else {
      const gaps: string[] = [];
      if (diffs.length < 2) gaps.push('I need at least two clear differentiators — things only you can claim');
      if (prios.length < 2) gaps.push(`I need at least two priorities that ${audName} genuinely cares about`);
      if (thinMFs.length > 1) gaps.push(`${thinMFs.length} of your differentiators are missing the "why would someone crave this" — without that, the message describes features instead of value`);
      if (thinDrivers.length > 1) gaps.push(`${thinDrivers.length} priorities are missing drivers — without knowing why THIS person cares, the message will feel generic`);

      reviewMsg = `I'm not quite ready to build. Here's what I need:\n\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}`;
      if (gentleQuestions.length > 0) {
        reviewMsg += `\n\nAlso — ${gentleQuestions[0]}`;
      }
      reviewMsg += `\n\nAdd what's missing in the card above, or tell me more and I'll fill it in.`;
      backlog.current = [...gentleQuestions.slice(1), ...observations].map(t => ({ text: t, phase: 'inputs' }));
    }

    addMessage({ type: 'maria', text: reviewMsg });
  }

  // ── Reply handling (review phases) ───────────────
  async function handleReply() {
    const domValue = textareaRef.current?.value || '';
    const text = (input || domValue).trim();
    if (!text) return;
    addMessage({ type: 'user', text });
    setInput('');

    const lower = text.toLowerCase();
    const isPositive = /looks? good|great|perfect|love it|^yes$|^yes[,. !]|nice|exactly|that works|correct/i.test(lower) && !/not|wrong|don't|doesn't|isn't|no way|off/i.test(lower);
    const isDismiss = /ok as is|fine|skip|move on|next/i.test(lower);
    const isQuestion = text.endsWith('?');
    const isWhatElse = /what else|anything else|what.*(miss|recommend|suggest)|other thoughts|show me more|tell me more|what are they|more observations|more feedback|what did you notice|your thoughts/i.test(lower);

    // ── Handle pending navigation confirmation ──
    if (pendingNavTarget && isPositive) {
      addMessage({ type: 'maria', text: "Taking you there now." });
      setPendingNavTarget(null);
      setTimeout(() => navigate(pendingNavTarget), 400);
      return;
    }
    if (pendingNavTarget && (isDismiss || /no|nah|stay|here|never ?mind/i.test(lower))) {
      setPendingNavTarget(null);
      addMessage({ type: 'maria', text: "OK, staying here. What else?" });
      return;
    }
    if (pendingNavTarget) {
      setPendingNavTarget(null);
      // Fall through — treat as a normal reply
    }

    // ── Navigation detection — offer to route when user mentions another page ──
    const navPatterns: { pattern: RegExp; label: string; path: string }[] = [
      { pattern: /\b(three[- ]?tier|foundation|message structure)\b/i, label: 'Three Tier page', path: '/three-tiers' },
      { pattern: /\b(audiences?|personas?|who am i talking to)\b/i, label: 'Audiences page', path: '/audiences' },
      { pattern: /\b(offerings?|products?|what (we|i) sell)\b/i, label: 'Offerings page', path: '/offerings' },
      { pattern: /\b(dashboard|home|overview)\b/i, label: 'Dashboard', path: '/' },
      { pattern: /\b(five[- ]?chapter|stories?|story)\b/i, label: 'Five Chapter page', path: '/five-chapters' },
    ];
    const navMatch = navPatterns.find(np => np.pattern.test(lower));
    // Only offer navigation when user is clearly asking to GO somewhere, not just discussing content
    const isNavIntent = navMatch && /\b(go|show|take|open|see|switch|navigate|look at|pull up|head to|jump to|back to|go to)\b/i.test(lower);
    if (isNavIntent && navMatch) {
      setPendingNavTarget(navMatch.path);
      addMessage({ type: 'maria', text: `Want me to take you to the ${navMatch.label}?` });
      return;
    }

    if (isWhatElse && backlog.current.length > 0) {
      const items = backlog.current;
      const count = items.length;
      addMessage({
        type: 'maria',
        text: `I have ${count} thing${count !== 1 ? 's' : ''} I noticed earlier. ${items.map((b, i) => `${i + 1}. ${b.text}`).join('\n')}`,
      });
      backlog.current = [];
      return;
    }
    if (isWhatElse) {
      addMessage({ type: 'maria', text: "I don't have anything else right now. Everything looks solid from my end." });
      return;
    }

    const isReviewRequest = /review|check|evaluate|look at|suggestions?|what would you (change|improve)/i.test(lower);
    const isRefineRequest = /refine|polish|make.*natural|sound.*better|conversational/i.test(lower);
    const isEditRequest = /change|shorten|lengthen|remove|replace|rewrite|make.*shorter|make.*longer|update/i.test(lower);

    if ((isReviewRequest || isRefineRequest) && phase === 'reviewing_foundation' && foundation) {
      addMessage({ type: 'maria', text: isRefineRequest
        ? "I'm refining the language now — making each statement sound like something you'd say at a small table, not in a brochure. About fifteen seconds."
        : "I'm reviewing each element against what I know works. About fifteen seconds. I'll show you alternatives for anything I'd change."
      });
      const thinkingId = addMessage({ type: 'thinking' });
      try {
        const endpoint = isRefineRequest ? '/ai/refine' : '/ai/review';
        const result = await api.post<{ suggestions?: { cell: string; suggested: string }[]; refinedTier1?: { best: string; alternative: string }; refinedTier2?: { index: number; text: string }[] }>(endpoint, { draftId: foundation.draftId });
        removeMessage(thinkingId);
        const changes = result.suggestions?.length || (result.refinedTier2?.length || 0) + (result.refinedTier1 ? 1 : 0);
        if (changes > 0) {
          setFoundationHasSuggestions(true);
          addMessage({ type: 'maria', text: `I'd adjust ${changes} thing${changes !== 1 ? 's' : ''}. Check the foundation card — my suggestions appear below each cell in lighter text with Accept or Dismiss buttons. The changes won't apply until you accept them.` });
        } else {
          setFoundationHasSuggestions(false);
          addMessage({ type: 'maria', text: "I reviewed everything and I wouldn't change any of it. It's solid. Click \"Use this foundation\" when you're ready to move to a deliverable." });
        }
      } catch {
        removeMessage(thinkingId);
        addMessage({ type: 'maria', text: "Something went wrong with the review. Try again, or click \"Use this foundation\" to move forward with what you have." });
      }
      return;
    }

    if (isEditRequest && foundation && phase === 'reviewing_foundation') {
      const thinkingId = addMessage({ type: 'thinking' });
      try {
        const result = await api.post<{ response: string; actionResult?: string | null }>('/partner/message', {
          message: text,
          context: {
            page: 'three-tier',
            draftId: foundation.draftId,
          },
        });
        removeMessage(thinkingId);
        addMessage({ type: 'maria', text: result.response || "Done. Check the foundation — your changes should be reflected." });
      } catch {
        removeMessage(thinkingId);
        addMessage({ type: 'maria', text: "I couldn't make that change automatically. Click the text in the card above and edit it directly." });
      }
      return;
    }

    if (phase === 'confirming_inputs') {
      if (isDismiss) {
        backlog.current.push({ text: 'Some differentiators or priorities may benefit from stronger "why" notes.', phase: 'inputs' });
        addMessage({
          type: 'maria',
          text: "OK, noted. Click \"Build my message\" when you're ready. You can always ask me \"what else?\" if you want my observations later.",
        });
      } else if (isPositive) {
        addMessage({
          type: 'maria',
          text: "Good. Click \"Build my message\" when you're ready.",
        });
      } else if (lower.includes('guess') || lower.includes('fill') || lower.includes('help')) {
        addMessage({
          type: 'maria',
          text: "I'll take my best guess on the missing ones. You can correct anything that doesn't feel right in the card above.",
        });
      } else if (lower.includes('not') && (lower.includes('#1') || lower.includes('top') || lower.includes('most important') || lower.includes('first'))) {
        addMessage({
          type: 'maria',
          text: "OK — what IS their top priority? What's the thing that keeps them up at night, even when they're not thinking about your kind of product? Drag it to the #1 position in the card, or tell me and I'll help you figure out where it belongs.",
        });
      } else if (lower.includes('add') || lower.includes('missing') || lower.includes('forgot') || lower.includes('also')) {
        addMessage({
          type: 'maria',
          text: "Good — add it using '+ Add a priority' or '+ Something I missed?' in the card above. Or just tell me what it is and I'll note it for the next version.",
        });
      } else if (isQuestion) {
        if (lower.includes('priority') || lower.includes('priorities')) {
          addMessage({ type: 'maria', text: "Priorities are what keeps your audience up at night — their concerns, pressures, goals — even when they're not thinking about your product. I rank them by urgency: what's the most pressing issue for this specific person right now? You can see them in the card above and drag to reorder. #1 is what your entire message will lead with." });
        } else if (lower.includes('driver')) {
          addMessage({ type: 'maria', text: "A driver is the personal reason behind a priority. Not just 'cost reduction' but WHY cost reduction matters to THIS person — maybe their board is pressuring them, or their budget was just cut. The driver is what makes the message feel personal instead of generic. You can add or edit drivers in the card above — look for \"Why does THIS person care?\" under each priority." });
        } else if (lower.includes('mf') || lower.includes('motivat') || lower.includes('why would someone crave')) {
          addMessage({ type: 'maria', text: "The 'why would someone crave this' is about your differentiator's emotional pull. Not what it does, but what it MEANS for the person. If your AI runs on existing equipment, the craving is 'no capital expenditure, no procurement nightmare, no IT project.' The consequence, not the feature. You can edit these in the card above — look for \"Why would someone crave this?\" under each differentiator." });
        } else {
          addMessage({ type: 'maria', text: "Good question. Edit the card directly for now — click any text to change it. The most important thing is that the priorities match what your audience actually cares about, not what you wish they cared about." });
        }
      } else {
        addMessage({
          type: 'maria',
          text: "Got it — update the card above to reflect that. Click any text to edit. When the differentiators and priorities look right, click \"Build my message.\"",
        });
      }
    } else if (phase === 'reviewing_foundation') {
      if (isPositive) {
        addMessage({
          type: 'maria',
          text: "Good. Click \"Use this foundation\" to lock it in. Every deliverable I create will start from this structure.",
        });
      } else if (lower.includes('roi') || lower.includes('financial') || lower.includes('cost') || lower.includes('money')) {
        addMessage({
          type: 'maria',
          text: "The ROI column is one of the hardest to get right — I need specific numbers or outcomes. Can you tell me what the financial impact looks like for your audience? Even a rough range helps.",
        });
      } else if (lower.includes('proof') || lower.includes('social') || lower.includes('customer') || lower.includes('reference')) {
        addMessage({
          type: 'maria',
          text: "I'm thin on proof points. Do you have customer names, case studies, certifications, or measurable outcomes I can use? Specific facts — not claims. A skeptic should be able to verify them.",
        });
      } else if (lower.includes('key message') || lower.includes('tier 1') || lower.includes('headline') || lower.includes('top') || lower.includes('main')) {
        addMessage({
          type: 'maria',
          text: "The key message connects your audience's #1 priority to your strongest differentiator. If it doesn't make them think 'I need to act on this,' try rewriting it as: what's the consequence of NOT acting? Click it to edit, or tell me what feels wrong and I'll suggest an alternative.",
        });
      } else if (lower.includes('support') || lower.includes('implementation') || lower.includes('training')) {
        addMessage({
          type: 'maria',
          text: "The support angle should make the reader feel safe saying yes. What does your onboarding, training, or ongoing support actually look like? Give me specifics — 'dedicated account manager for 90 days' is better than 'full support.'",
        });
      } else {
        addMessage({
          type: 'maria',
          text: "Tell me which part feels off — the key message at the top, one of the supporting statements, or the proof points? The more specific you are, the more I can help.",
        });
      }
    } else if (phase === 'complete') {
      if (isPositive) {
        addMessage({
          type: 'maria',
          text: "Copy it and make it yours. It's a first draft — not a deliverable. Your edits are what turn it into something you'd put your name on.",
        });
      } else if (isEditRequest || (!isQuestion && !isDismiss && text.length > 10)) {
        const thinkingId = addMessage({ type: 'thinking' });
        try {
          const currentMessages = messagesRef.current;
          const draftMsg = currentMessages.find(m => m.type === 'draft-view');
          const domDraft = document.querySelector('.guided-draft-view')?.getAttribute('data-draft-text') || '';
          const draftText = domDraft || latestDraftRef.current || draftMsg?.draft?.blendedText || '';
          const audienceName = interpretation?.audiences[0]?.name || 'the reader';

          if (draftText) {
            const editResult = await api.post<{ revisedDraft: string; summary: string }>('/express/edit-draft', {
              currentDraft: draftText,
              editInstruction: text,
              audienceName,
            });

            removeMessage(thinkingId);

            if (editResult.revisedDraft) {
              latestDraftRef.current = editResult.revisedDraft;
              if (draftMsg) {
                updateMessage(draftMsg.id, { draft: { ...draftMsg.draft!, blendedText: editResult.revisedDraft } });
              }
              const draftEl = document.querySelector('.guided-draft-view');
              if (draftEl) draftEl.setAttribute('data-draft-text', editResult.revisedDraft);
              addMessage({
                type: 'maria',
                text: editResult.summary || 'Done — the draft is updated above. Tell me what else to change.',
              });
            } else {
              addMessage({ type: 'maria', text: "I couldn't apply that edit. Try being more specific — which part and how you'd say it differently." });
            }
          } else {
            const tier1 = foundation?.tier1?.text || '';
            const tier2Lines = (foundation?.tier2 || []).map(t => `${t.categoryLabel}: ${t.text}`).join('\n');
            const contextBlock = `[FOUNDATION]\nKey message: ${tier1}\n${tier2Lines}\n[END FOUNDATION]\n\nUser's request: ${text}`;

            const result = await api.post<{ response: string }>('/partner/message', {
              message: contextBlock,
              context: { page: 'five-chapter', draftId: foundation?.draftId },
            });
            removeMessage(thinkingId);
            addMessage({ type: 'maria', text: result.response || "I hear you. Let me know what else to adjust." });
          }
        } catch {
          removeMessage(thinkingId);
          addMessage({ type: 'maria', text: "I couldn't process that right now. Try being more specific — which part feels off and how would you say it differently?" });
        }
      } else {
        addMessage({
          type: 'maria',
          text: "Tell me what to change — which part feels off and how you'd say it differently. I'll revise it.",
        });
      }
    }
  }

  // ── Stage navigation ─────────────────────────────
  function handleNavigate(stage: GuidedStage) {
    const stageIndex = stage === 'inputs' ? 0 : stage === 'foundation' ? 1 : 2;
    const cards = document.querySelectorAll('.guided-msg-card');
    if (cards[stageIndex]) {
      cards[stageIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ── Reset ────────────────────────────────────────
  function handleReset() {
    if (pollRef.current) clearInterval(pollRef.current);
    setPhase('greeting');
    setMessages([]);
    setInput('');
    setInterpretation(null);
    setFoundation(null);
    setSituation('');
    setDraftJobId('');
    setCompletedStages(new Set());
  }

  function handleCopy(text: string) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
        .then(() => showToast('Copied to clipboard.'))
        .catch(() => showToast('Could not copy — try selecting and copying manually.'));
    }
  }

  // ── Keyboard handling ────────────────────────────
  function handleKeyDown(e: React.KeyboardEvent) {
    const domValue = textareaRef.current?.value || '';
    const text = (input || domValue).trim();
    if (e.key === 'Enter' && !e.shiftKey && phase === 'greeting' && text.length >= 1) {
      e.preventDefault();
      handleIntakeReply();
    }
  }

  // ── Render ────────────────────────────────────────

  return (
    <div className={`guided-shell ${mode === 'panel' ? 'guided-shell-panel' : ''}`}>
      {/* ── Top chrome ──────────────────────────── */}
      {standalone && (
        <header className="guided-chrome">
          <div className="guided-chrome-brand">Maria</div>
          <nav className="guided-chrome-nav">
            <a className="guided-chrome-nav-link" href="/three-tiers">My work</a>
          </nav>
          <div className="guided-chrome-right">
            {activeWorkspace && (
              <span className="guided-chrome-workspace">{activeWorkspace.name}</span>
            )}
            {user && (
              <>
                <span className="guided-chrome-user">{user.username}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
                  Sign Out
                </button>
              </>
            )}
          </div>
        </header>
      )}

      {/* Panel-mode escape hatch: small link so the user can switch to assistant chat
          without losing the guided session. Appears only when parent provided the callback.
          Disabled while Maria is mid-generation — switching away abandons the in-flight reply. */}
      {mode === 'panel' && onSwitchToAssistant && (() => {
        const mariaThinking = messages.some(m => m.type === 'thinking');
        return (
          <div className="guided-panel-switch">
            <button
              type="button"
              className="guided-panel-switch-btn"
              onClick={mariaThinking ? undefined : onSwitchToAssistant}
              disabled={mariaThinking}
              title={mariaThinking
                ? "Hang on — Maria's writing your reply. You can switch as soon as she's done."
                : "Ask Maria something else — your guided message stays right here"}
            >
              {mariaThinking ? 'Maria is writing…' : '← Chat with Maria instead'}
            </button>
          </div>
        );
      })()}

      {/* ── Process bar ─────────────────────────── */}
      {phase !== 'greeting' && (
        <ProcessBar
          currentStage={currentStage()}
          completedStages={completedStages}
          onNavigate={handleNavigate}
          onReset={handleReset}
        />
      )}

      {/* ── Chat thread ─────────────────────────── */}
      <div className="guided-chat-area">
        <div className="guided-chat-thread">
          {/* Greeting — Maria speaks first, one question at a time */}
          {phase === 'greeting' && messages.length === 0 && (
            <div className="guided-greeting">
              <div className="guided-greeting-content">
                <div className="guided-greeting-maria">
                  <div className="guided-msg-avatar">M</div>
                  <div className="guided-greeting-bubble">
                    <h1 className="guided-greeting-title">Hi, I'm Maria.</h1>
                    <p className="guided-greeting-subtitle">
                      In about ten minutes, you'll have a first draft that makes your audience lean in — because it speaks to what they actually care about, not what you wish they cared about. Tell me about what you offer and what someone gets from it.
                    </p>
                    <p className="guided-greeting-hint">
                      Type, talk, or drop in a document — whatever's easiest.
                    </p>
                    <button
                      type="button"
                      className="guided-greeting-dismiss"
                      onClick={() => {
                        if (mode === 'panel' && onSwitchToAssistant) {
                          onSwitchToAssistant();
                        } else {
                          navigate('/');
                        }
                      }}
                    >
                      I'll build it myself
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map(msg => {
            switch (msg.type) {
              case 'maria':
                return (
                  <div key={msg.id} id={msg.id} className="guided-msg guided-msg-maria">
                    <div className="guided-msg-avatar">M</div>
                    <div className="guided-msg-bubble guided-msg-bubble-maria">
                      {(msg.text || '').split('\n').map((line, i) => (
                        <p key={i}>{line}</p>
                      ))}
                    </div>
                  </div>
                );

              case 'user':
                return (
                  <div key={msg.id} className="guided-msg guided-msg-user">
                    <div className="guided-msg-bubble guided-msg-bubble-user">
                      {(msg.text || '').length > 500
                        ? msg.text!.slice(0, 500).trim() + '…'
                        : msg.text}
                    </div>
                  </div>
                );

              case 'thinking':
                return (
                  <div key={msg.id} className="guided-msg guided-msg-maria">
                    <div className="guided-msg-avatar">M</div>
                    <div className="guided-msg-bubble guided-msg-bubble-maria guided-thinking">
                      <span className="guided-thinking-dot" />
                      <span className="guided-thinking-dot" />
                      <span className="guided-thinking-dot" />
                      {msg.text && <span className="guided-thinking-text">{msg.text}</span>}
                    </div>
                  </div>
                );

              case 'progress':
                return (
                  <div key={msg.id} className="guided-msg guided-msg-maria">
                    <div className="guided-msg-avatar">M</div>
                    <div className="guided-msg-bubble guided-msg-bubble-maria guided-progress">
                      <div className="guided-progress-bar">
                        <div
                          className="guided-progress-fill"
                          style={{ width: `${Math.max(3, Math.min(100, msg.progress || 0))}%` }}
                        />
                      </div>
                      <p className="guided-progress-stage">{msg.stage || 'Working on it'}</p>
                    </div>
                  </div>
                );

              case 'input-card':
                return msg.interpretation ? (
                  <div key={msg.id} className="guided-msg-card">
                    <InputConfirmationCard
                      interpretation={msg.interpretation}
                      onConfirm={handleConfirmInputs}
                    />
                  </div>
                ) : null;

              case 'foundation-card':
                return msg.foundation ? (
                  <div key={msg.id} className={`guided-msg-card${foundationHasSuggestions ? ' guided-foundation-has-suggestion' : ''}`}>
                    <FoundationCard
                      foundation={msg.foundation}
                      onConfirm={(f) => { setFoundationHasSuggestions(false); handleConfirmFoundation(f); }}
                      onRefineLanguage={() => {
                        if (foundation) {
                          window.location.href = `/three-tier/${foundation.draftId}?step=5`;
                        }
                      }}
                      onElementClick={(type, label, text) => {
                        addMessage({
                          type: 'maria',
                          text: type === 'tier1'
                            ? `About your key message: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}" — the test is whether ${interpretation?.audiences[0]?.name || 'your reader'} hears this and thinks "I can't ignore this." If it sounds like a brochure, it needs work. If it sounds like a truth they already suspect, it's close.`
                            : `About the ${label} column — this supports your key message from a specific angle. Each supporting statement should pass the small-table test: would you say this to a smart colleague over coffee? If it sounds like marketing copy, rewrite it in your own words.`,
                        });
                      }}
                    />
                  </div>
                ) : null;

              case 'format-prompt':
                return (
                  <div key={msg.id} className="guided-msg-card">
                    <FormatPrompt onSubmit={handleFormatChosen} />
                  </div>
                );

              case 'draft-view':
                return msg.draft ? (
                  <div key={msg.id} className="guided-msg-card">
                    <DraftView
                      blendedText={msg.draft.blendedText}
                      medium={msg.draft.medium}
                      chapters={msg.draft.chapters}
                      onCopy={() => handleCopy(msg.draft!.blendedText)}
                      onStartAnother={handleReset}
                    />
                  </div>
                ) : null;

              default:
                return null;
            }
          })}

          <div ref={chatEndRef} />
        </div>

        {/* ── Conversation input (review phases) ── */}
        {(phase === 'confirming_inputs' || phase === 'reviewing_foundation' || phase === 'complete') && (
          <div className="guided-reply-area">
            <textarea
              className="guided-reply-textarea"
              value={input}
              onChange={e => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && input.trim()) {
                  e.preventDefault();
                  handleReply();
                }
              }}
              placeholder={
                phase === 'confirming_inputs'
                  ? "Tell Maria what to adjust, or ask about any term you don't recognize..."
                  : phase === 'reviewing_foundation'
                  ? "Does the key message make your reader think 'I need to act'? What's off?"
                  : "Does any sentence sound like someone else wrote it? Tell me which ones."
              }
              rows={1}
            />
            <label className="guided-reply-attach" title="Attach a document">
              <input
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.txt,.pptx,.ppt,.csv,.md"
                className="guided-input-file-hidden"
                onChange={e => {
                  const files = Array.from(e.target.files || []);
                  if (files.length > 0) setAttachments(prev => [...prev, ...files]);
                  e.target.value = '';
                }}
              />
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.5 10.833V15a2.5 2.5 0 01-2.5 2.5H5A2.5 2.5 0 012.5 15v-4.167" />
                <path d="M13.333 5L10 1.667 6.667 5" />
                <path d="M10 1.667V12.5" />
              </svg>
            </label>
            <button
              type="button"
              className="guided-reply-mic"
              title="Voice input coming soon"
              onClick={() => showToast('Voice input coming soon — type your message for now.', 'info')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="1" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" />
                <line x1="12" y1="17" x2="12" y2="21" />
                <line x1="8" y1="21" x2="16" y2="21" />
              </svg>
            </button>
            <button
              type="button"
              className="btn btn-primary guided-reply-send"
              onClick={handleReply}
              disabled={!input.trim()}
            >
              Send
            </button>
          </div>
        )}

        {/* ── Input area (greeting) ────────────── */}
        {phase === 'greeting' && (
          <div
            className="guided-input-area"
            onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('guided-input-dragover'); }}
            onDragLeave={e => { e.currentTarget.classList.remove('guided-input-dragover'); }}
            onDrop={e => {
              e.preventDefault();
              e.currentTarget.classList.remove('guided-input-dragover');
              const files = Array.from(e.dataTransfer.files);
              if (files.length > 0) setAttachments(prev => [...prev, ...files]);
            }}
          >
            <textarea
              ref={textareaRef}
              className="guided-input-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Reply to Maria..."
              rows={typeof window !== 'undefined' && window.innerWidth <= 600 ? 2 : 4}
              autoFocus
            />
            {attachments.length > 0 && (
              <div className="guided-input-attachments">
                {attachments.map((f, i) => (
                  <span key={i} className="guided-input-attachment">
                    <span className="guided-input-attachment-icon">📎</span>
                    {f.name}
                    <button
                      type="button"
                      className="guided-input-attachment-remove"
                      onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                    >×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="guided-input-actions">
              <label className="guided-input-attach-btn" title="Attach documents (PDF, Word, PowerPoint, text)">
                <input
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.txt,.pptx,.ppt,.csv,.md"
                  className="guided-input-file-hidden"
                  onChange={e => {
                    const files = Array.from(e.target.files || []);
                    if (files.length > 0) setAttachments(prev => [...prev, ...files]);
                    e.target.value = '';
                  }}
                />
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.5 10.833V15a2.5 2.5 0 01-2.5 2.5H5A2.5 2.5 0 012.5 15v-4.167" />
                  <path d="M13.333 5L10 1.667 6.667 5" />
                  <path d="M10 1.667V12.5" />
                </svg>
              </label>
              <button
                type="button"
                className="guided-input-mic-btn"
                title="Voice input coming soon"
                onClick={() => showToast('Voice input coming soon — type your message for now.', 'info')}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="1" width="6" height="12" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                </svg>
              </button>
              <button
                type="button"
                className="btn btn-primary guided-input-send"
                onClick={() => handleIntakeReply()}
                disabled={
                  (input.trim().length < 1 && (textareaRef.current?.value || '').trim().length < 1) && attachments.length === 0
                }
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── FormatPrompt sub-component ─────────────────────
function FormatPrompt({ onSubmit }: { onSubmit: (medium: string, cta: string) => void }) {
  const [medium, setMedium] = useState('');
  const [customMedium, setCustomMedium] = useState('');
  const [cta, setCta] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const QUICK_PICKS: { medium: string; label: string; hint: string }[] = [
    { medium: 'email', label: 'Email', hint: 'A follow-up or cold outreach' },
    { medium: 'pitch deck', label: 'Pitch deck', hint: 'Narrative for slides' },
    { medium: 'one-pager', label: 'One-pager', hint: 'Leave-behind after a meeting' },
    { medium: 'talking points', label: 'Talking points', hint: 'For a call or presentation' },
  ];

  const effectiveMedium = showCustom ? customMedium.trim() : medium;

  return (
    <div className="guided-format-prompt">
      <div className="guided-format-picks">
        {QUICK_PICKS.map(opt => (
          <button
            key={opt.medium}
            type="button"
            className={`guided-format-pick ${medium === opt.medium && !showCustom ? 'guided-format-pick-active' : ''}`}
            onClick={() => { setMedium(opt.medium); setShowCustom(false); }}
          >
            <span className="guided-format-pick-label">{opt.label}</span>
            <span className="guided-format-pick-hint">{opt.hint}</span>
          </button>
        ))}
      </div>
      <div className="guided-format-more">
        <select
          className="guided-format-inline-select"
          value={!showCustom && medium && !QUICK_PICKS.some(p => p.medium === medium) ? medium : ''}
          onChange={e => {
            if (e.target.value === '__custom') {
              setShowCustom(true);
              setMedium('');
            } else {
              setMedium(e.target.value);
              setShowCustom(false);
            }
          }}
        >
          <option value="">Other formats...</option>
          {MEDIUM_OPTIONS
            .filter(opt => !QUICK_PICKS.some(p => p.medium === opt.value))
            .map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          <option value="__custom">Something else...</option>
        </select>
        {showCustom && (
          <input
            className="guided-format-input"
            value={customMedium}
            onChange={e => setCustomMedium(e.target.value)}
            placeholder="e.g., Board letter, tournament invitation, investor update"
            autoFocus
            style={{ marginTop: 8 }}
          />
        )}
      </div>
      {effectiveMedium && (
        <div className="guided-format-cta-area">
          <label className="guided-format-label">What should the reader do next?</label>
          <input
            className="guided-format-input"
            value={cta}
            onChange={e => setCta(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && cta.trim()) onSubmit(effectiveMedium, cta); }}
            placeholder="e.g., Schedule a 30-minute call, Visit our website, Reply to this email"
            autoFocus
          />
          <button
            type="button"
            className="btn btn-primary guided-format-go"
            onClick={() => onSubmit(effectiveMedium, cta)}
            disabled={!cta.trim()}
          >
            Write it
          </button>
        </div>
      )}
    </div>
  );
}

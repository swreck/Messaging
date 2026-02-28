import { useState } from 'react';
import type { StepProps } from './types';
import { CoachingChat } from '../components/CoachingChat';
import { api } from '../../api/client';

export function Step2AllAboutYou({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const [elements, setElements] = useState(draft.offering.elements.map(e => e.text));
  const [newItem, setNewItem] = useState('');

  async function addElement(text: string) {
    if (!text.trim()) return;
    if (elements.includes(text.trim())) return;

    await api.post(`/offerings/${draft.offeringId}/elements`, {
      text: text.trim(),
      source: 'ai_extracted',
    });
    setElements(prev => [...prev, text.trim()]);
    await loadDraft();
  }

  async function addManualElement(e: React.FormEvent) {
    e.preventDefault();
    if (!newItem.trim()) return;
    await api.post(`/offerings/${draft.offeringId}/elements`, {
      text: newItem.trim(),
      source: 'manual',
    });
    setElements(prev => [...prev, newItem.trim()]);
    setNewItem('');
    await loadDraft();
  }

  async function removeElement(index: number) {
    const el = draft.offering.elements[index];
    if (el) {
      await api.delete(`/offerings/${draft.offeringId}/elements/${el.id}`);
      setElements(prev => prev.filter((_, i) => i !== index));
      await loadDraft();
    }
  }

  return (
    <div className="step-panel">
      <h2>Tell Me About Your Offering</h2>
      <p className="step-description">
        Let's build a list of everything that makes {draft.offering.name} special. Maria will ask you questions — items she identifies will appear in the sidebar. You can also add your own.
      </p>

      <div className="coaching-layout">
        <CoachingChat
          draftId={draft.id}
          step={2}
          initialPrompt={`I'd like to understand what makes "${draft.offering.name}" special. Let's start.`}
          onExtractItem={addElement}
        />

        <div className="extracted-sidebar">
          <h3>Capabilities ({elements.length})</h3>
          {elements.map((text, i) => (
            <div key={i} className="extracted-item">
              <span style={{ flex: 1 }}>{text}</span>
              <button className="btn btn-ghost btn-sm btn-danger" onClick={() => removeElement(i)} title="Remove">&times;</button>
            </div>
          ))}
          <form onSubmit={addManualElement} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input
              value={newItem}
              onChange={e => setNewItem(e.target.value)}
              placeholder="Add manually..."
              style={{ flex: 1, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 13 }}
            />
            <button className="btn btn-secondary btn-sm" type="submit">Add</button>
          </form>
        </div>
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" onClick={prevStep}>Back</button>
        <button className="btn btn-primary" onClick={nextStep} disabled={elements.length < 3}>
          Next: Your Audience ({elements.length} items)
        </button>
      </div>
    </div>
  );
}

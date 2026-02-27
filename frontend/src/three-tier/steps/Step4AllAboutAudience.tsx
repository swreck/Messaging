import { useState } from 'react';
import type { StepProps } from './types';
import { CoachingChat } from '../components/CoachingChat';
import { api } from '../../api/client';
import { InfoTooltip } from '../../shared/InfoTooltip';
import type { Priority } from '../../types';

export function Step4AllAboutAudience({ draft, loadDraft, nextStep, prevStep }: StepProps) {
  const [priorities, setPriorities] = useState<Priority[]>(draft.audience.priorities);
  const [newItem, setNewItem] = useState('');

  async function addPriority(text: string) {
    if (!text.trim()) return;
    if (priorities.find(p => p.text === text.trim())) return;

    const { priority } = await api.post<{ priority: Priority }>(`/audiences/${draft.audienceId}/priorities`, {
      text: text.trim(),
      rank: priorities.length + 1,
    });
    setPriorities(prev => [...prev, priority]);
    await loadDraft();
  }

  async function addManualPriority(e: React.FormEvent) {
    e.preventDefault();
    if (!newItem.trim()) return;
    await addPriority(newItem.trim());
    setNewItem('');
  }

  async function removePriority(id: string) {
    await api.delete(`/audiences/${draft.audienceId}/priorities/${id}`);
    setPriorities(prev => prev.filter(p => p.id !== id));
    await loadDraft();
  }

  async function updatePriority(id: string, field: string, value: string) {
    await api.put(`/audiences/${draft.audienceId}/priorities/${id}`, { [field]: value });
    setPriorities(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
  }

  return (
    <div className="step-panel">
      <h2>
        Step 4: All About Your Audience
        <InfoTooltip text="List what your audience cares about — both spoken priorities (cost, quality, speed) and unspoken ones (job security, promotion, sanity). Unspoken priorities are more powerful for persuasion." />
      </h2>
      <p className="step-description">
        Now let's understand what your audience cares about. Maria will help you discover both the obvious priorities and the hidden ones. For each, we need to know WHY it matters to them.
      </p>

      <div className="coaching-layout">
        <CoachingChat
          draftId={draft.id}
          step={4}
          initialPrompt={`I'd like to understand the priorities of "${draft.audience.name}". What matters most to them when evaluating something like "${draft.offering.name}"?`}
          onExtractItem={addPriority}
        />

        <div className="extracted-sidebar">
          <h3>Priorities ({priorities.length})</h3>
          {priorities.map((p) => (
            <div key={p.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-light)' }}>
              <div className="extracted-item" style={{ borderBottom: 'none', padding: 0 }}>
                <span style={{ flex: 1, fontWeight: 500 }}>#{p.rank || '?'} {p.text}</span>
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => removePriority(p.id)} title="Remove">&times;</button>
              </div>
              <input
                placeholder="Why is this important to them?"
                value={p.motivatingFactor}
                onChange={e => updatePriority(p.id, 'motivatingFactor', e.target.value)}
                onBlur={e => updatePriority(p.id, 'motivatingFactor', e.target.value)}
                style={{ width: '100%', padding: '4px 8px', border: '1px solid var(--border-light)', borderRadius: 4, fontSize: 12, marginTop: 4 }}
              />
            </div>
          ))}
          <form onSubmit={addManualPriority} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
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
        <button className="btn btn-primary" onClick={nextStep} disabled={priorities.length < 2}>
          Next: Draw Lines ({priorities.length} priorities)
        </button>
      </div>
    </div>
  );
}

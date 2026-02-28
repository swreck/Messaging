import { useState } from 'react';
import { api } from '../../api/client';
import { CellEditor } from './CellEditor';
import { CellVersionNav } from './CellVersionNav';
import type { ThreeTierDraft } from '../../types';

interface ThreeTierTableProps {
  draft: ThreeTierDraft;
  onUpdate: () => void;
  suggestions?: Map<string, string>;
  onAcceptSuggestion?: (cell: string, text: string) => void;
  onDismissSuggestion?: (cell: string) => void;
}

export function ThreeTierTable({ draft, onUpdate, suggestions, onAcceptSuggestion, onDismissSuggestion }: ThreeTierTableProps) {
  const [editingCell, setEditingCell] = useState<string | null>(null);

  async function updateTier1(text: string) {
    if (text && text !== draft.tier1Statement?.text) {
      await api.put(`/tiers/${draft.id}/tier1`, { text, changeSource: 'manual' });
      onUpdate();
    }
    setEditingCell(null);
  }

  async function updateTier2(tier2Id: string, text: string, currentText: string) {
    if (text && text !== currentText) {
      await api.put(`/tiers/${draft.id}/tier2/${tier2Id}`, { text, changeSource: 'manual' });
      onUpdate();
    }
    setEditingCell(null);
  }

  async function updateTier3(tier3Id: string, text: string, currentText: string) {
    if (text && text !== currentText) {
      await api.put(`/tiers/${draft.id}/tier3/${tier3Id}`, { text, changeSource: 'manual' });
      onUpdate();
    }
    setEditingCell(null);
  }

  async function addTier3(tier2Id: string) {
    await api.post(`/tiers/${draft.id}/tier2/${tier2Id}/tier3`, { text: 'New proof point', changeSource: 'manual' });
    onUpdate();
  }

  async function deleteTier3(tier3Id: string) {
    await api.delete(`/tiers/${draft.id}/tier3/${tier3Id}`);
    onUpdate();
  }

  function copyTableToClipboard() {
    const tier1 = draft.tier1Statement?.text || '';
    const lines = [tier1, '', '---'];
    for (const t2 of draft.tier2Statements) {
      lines.push('', t2.text);
      for (const t3 of t2.tier3Bullets) {
        lines.push(`  • ${t3.text}`);
      }
    }
    navigator.clipboard.writeText(lines.join('\n'));
  }

  return (
    <div>
      <div className="three-tier-table">
        {/* Tier 1 */}
        <div className="tier1-row">
          {editingCell === 'tier1' ? (
            <CellEditor
              text={draft.tier1Statement?.text || ''}
              maxWords={20}
              onSave={updateTier1}
              onCancel={() => setEditingCell(null)}
            />
          ) : (
            <div className="tier1-text" onClick={() => setEditingCell('tier1')}>
              {draft.tier1Statement?.text || 'Click to add Tier 1 statement'}
            </div>
          )}
          {suggestions?.has('tier1') && (
            <div className="inline-suggestion" onClick={() => onAcceptSuggestion?.('tier1', suggestions.get('tier1')!)}>
              <span className="inline-suggestion-text">{suggestions.get('tier1')}</span>
              <button className="inline-suggestion-dismiss" onClick={(e) => { e.stopPropagation(); onDismissSuggestion?.('tier1'); }}>&times;</button>
            </div>
          )}
          {draft.tier1Statement && (
            <CellVersionNav
              cellId={draft.tier1Statement.id}
              cellType="tier1"
              onRestore={() => onUpdate()}
            />
          )}
        </div>

        {/* Tier 2 + Tier 3 */}
        <div className="tier2-row">
          {draft.tier2Statements.map((t2, t2Index) => {
            const t2Key = `tier2-${t2Index}`;
            return (
              <div key={t2.id} className="tier2-col">
                {t2.categoryLabel && (
                  <div className="tier2-category-label">{t2.categoryLabel}</div>
                )}
                {editingCell === `tier2-${t2.id}` ? (
                  <div style={{ padding: 8 }}>
                    <CellEditor
                      text={t2.text}
                      maxWords={20}
                      onSave={(text) => updateTier2(t2.id, text, t2.text)}
                      onCancel={() => setEditingCell(null)}
                    />
                  </div>
                ) : (
                  <div className="tier2-text" onClick={() => setEditingCell(`tier2-${t2.id}`)}>
                    {t2.text}
                  </div>
                )}
                {suggestions?.has(t2Key) && (
                  <div className="inline-suggestion" onClick={() => onAcceptSuggestion?.(t2Key, suggestions.get(t2Key)!)}>
                    <span className="inline-suggestion-text">{suggestions.get(t2Key)}</span>
                    <button className="inline-suggestion-dismiss" onClick={(e) => { e.stopPropagation(); onDismissSuggestion?.(t2Key); }}>&times;</button>
                  </div>
                )}
                <CellVersionNav cellId={t2.id} cellType="tier2" onRestore={() => onUpdate()} />

                <div className="tier3-area">
                  {t2.tier3Bullets.map((t3, t3Index) => {
                    const t3Key = `tier3-${t2Index}-${t3Index}`;
                    return (
                      <div key={t3.id} style={{ position: 'relative' }}>
                        {editingCell === `tier3-${t3.id}` ? (
                          <CellEditor
                            text={t3.text}
                            maxWords={6}
                            onSave={(text) => updateTier3(t3.id, text, t3.text)}
                            onCancel={() => setEditingCell(null)}
                          />
                        ) : (
                          <div className="tier3-bullet" onClick={() => setEditingCell(`tier3-${t3.id}`)}>
                            <span>{t3.text}</span>
                            <button
                              className="btn btn-ghost btn-sm btn-danger"
                              onClick={(e) => { e.stopPropagation(); deleteTier3(t3.id); }}
                              style={{ padding: '0 4px', fontSize: 11, opacity: 0.4 }}
                            >
                              &times;
                            </button>
                          </div>
                        )}
                        {suggestions?.has(t3Key) && (
                          <div className="inline-suggestion" onClick={() => onAcceptSuggestion?.(t3Key, suggestions.get(t3Key)!)}>
                            <span className="inline-suggestion-text">{suggestions.get(t3Key)}</span>
                            <button className="inline-suggestion-dismiss" onClick={(e) => { e.stopPropagation(); onDismissSuggestion?.(t3Key); }}>&times;</button>
                          </div>
                        )}
                        <CellVersionNav cellId={t3.id} cellType="tier3" onRestore={() => onUpdate()} />
                      </div>
                    );
                  })}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => addTier3(t2.id)}
                    style={{ fontSize: 12, marginTop: 4, padding: '2px 8px' }}
                  >
                    + Add proof
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8, gap: 8 }}>
        <button className="copy-btn" onClick={copyTableToClipboard}>
          Copy Table
        </button>
      </div>
    </div>
  );
}

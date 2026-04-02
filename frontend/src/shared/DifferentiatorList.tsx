import { useState } from 'react';
import { ReorderableList, type DragHandleProps } from './ReorderableList';
import { InlineBanner } from './InlineBanner';
import { api } from '../api/client';
import type { OfferingElement } from '../types';

interface DifferentiatorListProps {
  offeringId: string;
  elements: OfferingElement[];
  onUpdate: () => void;
  allowAdd?: boolean;
  allowRemove?: boolean;
}

export function DifferentiatorList({
  offeringId,
  elements,
  onUpdate,
  allowAdd = true,
  allowRemove = true,
}: DifferentiatorListProps) {
  const [newItem, setNewItem] = useState('');
  const [showBanner, setShowBanner] = useState(false);

  async function handleReorder(newItems: OfferingElement[]) {
    if (!localStorage.getItem('maria-diff-reorder-info')) {
      setShowBanner(true);
    }
    const ids = newItems.map(e => e.id);
    await api.put(`/offerings/${offeringId}/elements/reorder`, { elementIds: ids });
    onUpdate();
  }

  async function addElement(e: React.FormEvent) {
    e.preventDefault();
    if (!newItem.trim()) return;
    await api.post(`/offerings/${offeringId}/elements`, {
      text: newItem.trim(),
      source: 'manual',
    });
    setNewItem('');
    onUpdate();
  }

  async function removeElement(id: string) {
    await api.delete(`/offerings/${offeringId}/elements/${id}`);
    onUpdate();
  }

  async function updateMotivatingFactor(elementId: string, value: string) {
    await api.put(`/offerings/${offeringId}/elements/${elementId}`, { motivatingFactor: value });
  }

  function renderElement(item: OfferingElement, _index: number, { listeners, attributes }: DragHandleProps) {
    const hasMF = !!item.motivatingFactor;
    return (
      <div className="differentiator-item">
        <span className="drag-handle" {...listeners} {...attributes}>⠿</span>
        <div style={{ flex: 1 }}>
          <span className="differentiator-text">{item.text}</span>
          <div className={`mf-field ${hasMF ? 'mf-drafted' : 'mf-ready'}`}>
            <input
              className="mf-input"
              placeholder="Why would someone care?"
              defaultValue={item.motivatingFactor}
              onBlur={e => updateMotivatingFactor(item.id, e.target.value)}
            />
            {!hasMF && (
              <svg className="mf-maria-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c06070" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            )}
          </div>
        </div>
        {allowRemove && (
          <button
            className="btn btn-ghost btn-sm btn-danger"
            onClick={() => removeElement(item.id)}
            title="Remove"
          >&times;</button>
        )}
      </div>
    );
  }

  function renderOverlay(item: OfferingElement) {
    return (
      <div className="differentiator-item drag-overlay">
        <span className="drag-handle">⠿</span>
        <span className="differentiator-text">{item.text}</span>
      </div>
    );
  }

  return (
    <div className="differentiator-list">
      {showBanner && (
        <InlineBanner
          message="Changing the order of differentiators does not change the messaging. The order is for your reference."
          storageKey="maria-diff-reorder-info"
          dismissLabel="Got it"
        />
      )}

      <ReorderableList
        items={elements}
        getId={e => e.id}
        renderItem={renderElement}
        renderOverlay={renderOverlay}
        onReorder={handleReorder}
      />

      {allowAdd && (
        <form onSubmit={addElement} className="differentiator-add-form">
          <input
            value={newItem}
            onChange={e => setNewItem(e.target.value)}
            placeholder="Add a capability..."
          />
          <button className="btn btn-secondary btn-sm" type="submit">Add</button>
        </form>
      )}
    </div>
  );
}

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
    // Show info banner on first reorder
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

  function renderElement(item: OfferingElement, _index: number, { listeners, attributes }: DragHandleProps) {
    return (
      <div className="differentiator-item">
        <span className="drag-handle" {...listeners} {...attributes}>⠿</span>
        <span className="differentiator-text">{item.text}</span>
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

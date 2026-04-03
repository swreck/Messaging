import { useState, useEffect } from 'react';
import { ReorderableList, type DragHandleProps } from './ReorderableList';
import { ConfirmDialog } from './ConfirmDialog';
import { api } from '../api/client';
import type { Priority } from '../types';

interface PriorityListProps {
  audienceId: string;
  audienceName: string;
  priorities: Priority[];
  onUpdate: () => void;
  showMotivatingFactor?: boolean;
  allowAdd?: boolean;
  allowRemove?: boolean;
}

export function PriorityList({
  audienceId,
  audienceName,
  priorities,
  onUpdate,
  showMotivatingFactor = true,
  allowAdd = true,
  allowRemove = true,
}: PriorityListProps) {
  // Local copy for optimistic UI updates (drag-and-drop updates instantly)
  const [localPriorities, setLocalPriorities] = useState(priorities);
  useEffect(() => { setLocalPriorities(priorities); }, [priorities]);

  const [newItem, setNewItem] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [expandedMF, setExpandedMF] = useState<Set<string>>(new Set());
  const [confirmReorder, setConfirmReorder] = useState<{
    items: Priority[];
    oldIndex: number;
    newIndex: number;
  } | null>(null);

  async function handleReorder(newItems: Priority[], oldIndex: number, newIndex: number) {
    if (newIndex === 0 && oldIndex !== 0) {
      setConfirmReorder({ items: newItems, oldIndex, newIndex });
      return;
    }
    await commitReorder(newItems);
  }

  async function commitReorder(newItems: Priority[]) {
    // Optimistic: update display immediately
    setLocalPriorities(newItems);
    const ids = newItems.map(p => p.id);
    await api.put(`/audiences/${audienceId}/priorities/reorder`, { priorityIds: ids });
    onUpdate();
  }

  async function handleConfirmReorder() {
    if (!confirmReorder) return;
    await commitReorder(confirmReorder.items);
    setConfirmReorder(null);
  }

  async function addPriority(e: React.FormEvent) {
    e.preventDefault();
    if (!newItem.trim()) return;
    const text = newItem.trim();
    // Optimistic: show immediately with a temp ID
    const tempPriority: Priority = {
      id: `temp-${Date.now()}`,
      audienceId,
      text,
      rank: localPriorities.length + 1,
      sortOrder: localPriorities.length,
      motivatingFactor: '',
      whatAudienceThinks: '',
      isSpoken: false,
    };
    setLocalPriorities(prev => [...prev, tempPriority]);
    setNewItem('');
    await api.post(`/audiences/${audienceId}/priorities`, {
      text,
      rank: localPriorities.length + 1,
    });
    onUpdate();
  }

  async function removePriority(id: string) {
    // Optimistic: remove immediately
    setLocalPriorities(prev => prev.filter(p => p.id !== id));
    await api.delete(`/audiences/${audienceId}/priorities/${id}`);
    onUpdate();
  }

  async function updateMotivatingFactor(id: string, value: string) {
    await api.put(`/audiences/${audienceId}/priorities/${id}`, { motivatingFactor: value });
    onUpdate();
  }

  function startEditing(item: Priority) {
    setEditingId(item.id);
    setEditText(item.text);
  }

  async function saveEdit(id: string) {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === localPriorities.find(p => p.id === id)?.text) {
      setEditingId(null);
      return;
    }
    setLocalPriorities(prev => prev.map(p => p.id === id ? { ...p, text: trimmed } : p));
    setEditingId(null);
    await api.put(`/audiences/${audienceId}/priorities/${id}`, { text: trimmed });
    onUpdate();
  }

  function toggleMF(id: string) {
    setExpandedMF(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderPriority(item: Priority, index: number, { listeners, attributes }: DragHandleProps) {
    const isFirst = index === 0;
    const showMF = isFirst || expandedMF.has(item.id) || !!item.motivatingFactor;
    return (
      <div className={`priority-item ${isFirst ? 'priority-top' : ''}`}>
        <div className="priority-item-row">
          <span className="drag-handle" {...listeners} {...attributes}>⠿</span>
          <span className={`priority-rank ${isFirst ? 'rank-top' : ''}`}>{index + 1}</span>
          {editingId === item.id ? (
            <input
              className="priority-text-input"
              value={editText}
              onChange={e => setEditText(e.target.value)}
              onBlur={() => saveEdit(item.id)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveEdit(item.id);
                if (e.key === 'Escape') setEditingId(null);
              }}
              autoFocus
            />
          ) : (
            <span className="priority-text" onClick={() => startEditing(item)}>{item.text}</span>
          )}
          {isFirst && <span className="priority-top-label">Top Priority</span>}
          {allowRemove && (
            <button
              className="btn btn-ghost btn-sm btn-danger"
              onClick={() => removePriority(item.id)}
              title="Remove"
            >&times;</button>
          )}
        </div>
        {showMotivatingFactor && isFirst && (
          <div className="priority-mf-wrapper">
            <div className={`driver-field ${item.motivatingFactor ? 'driver-drafted' : 'driver-ready'}`}>
              <input
                className="driver-input"
                placeholder="Why is this so important to them?"
                defaultValue={item.motivatingFactor}
                onBlur={e => updateMotivatingFactor(item.id, e.target.value)}
              />
            </div>
            <span className="priority-mf-label">Drives Chapter 1 of your stories</span>
          </div>
        )}
        {showMotivatingFactor && !isFirst && showMF && (
          <div className={`driver-field ${item.motivatingFactor ? 'driver-drafted' : 'driver-ready'}`}>
            <input
              className="driver-input"
              placeholder="Why is this important to them?"
              defaultValue={item.motivatingFactor}
              onBlur={e => updateMotivatingFactor(item.id, e.target.value)}
            />
            {!item.motivatingFactor && (
              <svg className="driver-maria-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c06070" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            )}
          </div>
        )}
        {showMotivatingFactor && !isFirst && !showMF && (
          <button
            className="priority-mf-expand"
            onClick={() => toggleMF(item.id)}
          >
            + Why is this important to them?
          </button>
        )}
      </div>
    );
  }

  function renderOverlay(item: Priority) {
    return (
      <div className="priority-item drag-overlay">
        <div className="priority-item-row">
          <span className="drag-handle">⠿</span>
          <span className="priority-rank">{localPriorities.indexOf(item) + 1}</span>
          <span className="priority-text">{item.text}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="priority-list">
      {localPriorities.length > 1 && (
        <div className="priority-list-hint">
          Ranked by importance — drag to reorder
        </div>
      )}
      <ReorderableList
        items={localPriorities}
        getId={p => p.id}
        renderItem={renderPriority}
        renderOverlay={renderOverlay}
        onReorder={handleReorder}
      />

      {allowAdd && (
        <form onSubmit={addPriority} className="priority-add-form">
          <input
            value={newItem}
            onChange={e => setNewItem(e.target.value)}
            placeholder="Add a priority..."
          />
          <button className="btn btn-secondary btn-sm" type="submit">Add</button>
        </form>
      )}

      <ConfirmDialog
        open={!!confirmReorder}
        title="Change Top Priority?"
        message={`Changing ${audienceName}'s top priority will drive significant change to messaging. Continue?`}
        confirmLabel="Yes"
        cancelLabel="Cancel"
        onConfirm={handleConfirmReorder}
        onCancel={() => setConfirmReorder(null)}
      />
    </div>
  );
}

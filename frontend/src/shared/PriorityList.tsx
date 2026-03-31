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
            <input
              className="priority-mf-input priority-mf-top"
              placeholder="Why is this most important to them?"
              defaultValue={item.motivatingFactor}
              onBlur={e => updateMotivatingFactor(item.id, e.target.value)}
            />
            <span className="priority-mf-label">Drives Chapter 1 of your stories</span>
          </div>
        )}
        {showMotivatingFactor && !isFirst && showMF && (
          <input
            className="priority-mf-input"
            placeholder="Why is this important to them?"
            defaultValue={item.motivatingFactor}
            onBlur={e => updateMotivatingFactor(item.id, e.target.value)}
          />
        )}
        {showMotivatingFactor && !isFirst && !showMF && (
          <button
            className="priority-mf-expand"
            onClick={() => toggleMF(item.id)}
          >
            + Add motivating factor
          </button>
        )}
        {showMotivatingFactor && !item.motivatingFactor && (isFirst || showMF) && (
          <span className="mf-hint" onClick={() => {
            if (!isFirst && !expandedMF.has(item.id)) toggleMF(item.id);
          }}>
            Why does this matter?
          </span>
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

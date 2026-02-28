import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface ReorderableListProps<T> {
  items: T[];
  getId: (item: T) => string;
  renderItem: (item: T, index: number, dragHandleProps: DragHandleProps) => React.ReactNode;
  renderOverlay?: (item: T) => React.ReactNode;
  onReorder: (items: T[], oldIndex: number, newIndex: number) => void;
}

export interface DragHandleProps {
  listeners: Record<string, Function> | undefined;
  attributes: Record<string, any>;
}

function SortableItem<T>({
  item,
  index,
  getId,
  renderItem,
}: {
  item: T;
  index: number;
  getId: (item: T) => string;
  renderItem: (item: T, index: number, dragHandleProps: DragHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: getId(item) });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      {renderItem(item, index, { listeners, attributes })}
    </div>
  );
}

export function ReorderableList<T>({
  items,
  getId,
  renderItem,
  renderOverlay,
  onReorder,
}: ReorderableListProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.findIndex(item => getId(item) === active.id);
    const newIndex = items.findIndex(item => getId(item) === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newItems = arrayMove(items, oldIndex, newIndex);
    onReorder(newItems, oldIndex, newIndex);
  }

  const activeItem = activeId ? items.find(item => getId(item) === activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items.map(getId)} strategy={verticalListSortingStrategy}>
        {items.map((item, index) => (
          <SortableItem
            key={getId(item)}
            item={item}
            index={index}
            getId={getId}
            renderItem={renderItem}
          />
        ))}
      </SortableContext>
      <DragOverlay>
        {activeItem && renderOverlay ? renderOverlay(activeItem) : null}
      </DragOverlay>
    </DndContext>
  );
}

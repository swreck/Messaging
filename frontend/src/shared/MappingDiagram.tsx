import { useRef, useLayoutEffect, useState, useCallback, useEffect } from 'react';

interface MappingDiagramProps {
  priorities: { id: string; text: string; rank: number }[];
  elements: { id: string; text: string }[];
  mappings: { priorityId: string; elementId: string }[];
  audienceName: string;
  offeringName: string;
  onChange?: (mappings: { priorityId: string; elementId: string }[]) => void;
}

interface LineData {
  priorityId: string;
  elementId: string;
  x1: number; y1: number;
  x2: number; y2: number;
  color: string;
}

interface DragInfo {
  fromType: 'priority' | 'element';
  fromId: string;
  original: { priorityId: string; elementId: string } | null;
  fixedX: number; fixedY: number;
  mouseX: number; mouseY: number;
}

const PALETTE = [
  '#5B8DEF', // blue
  '#4CAF68', // green
  '#E8A347', // amber
  '#9B6BC7', // purple
  '#D9615A', // coral
  '#50B0D9', // teal
];

function rgba(hex: string, a: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function spreadY(top: number, h: number, i: number, n: number) {
  if (n <= 1) return top + h / 2;
  const pad = Math.min(8, h * 0.15);
  return top + pad + ((h - pad * 2) / (n - 1)) * i;
}

function curve(x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  return `M ${x1},${y1} C ${x1 + dx * 0.4},${y1} ${x2 - dx * 0.4},${y2} ${x2},${y2}`;
}

export function MappingDiagram({
  priorities, elements, mappings: initial,
  audienceName, offeringName, onChange,
}: MappingDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leftRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const rightRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const [local, setLocal] = useState(initial);
  const [lines, setLines] = useState<LineData[]>([]);
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const dragRef = useRef(drag);
  dragRef.current = drag;
  const localRef = useRef(local);
  localRef.current = local;

  const sorted = [...priorities].sort((a, b) => a.rank - b.rank);

  const color = useCallback((pid: string) => {
    const idx = sorted.findIndex(p => p.id === pid);
    return PALETTE[idx >= 0 ? idx % PALETTE.length : 0];
  }, [sorted.map(s => s.id).join()]);

  // Groupings for endpoint distribution
  const byP = new Map<string, string[]>();
  const byE = new Map<string, string[]>();
  for (const m of local) {
    byP.set(m.priorityId, [...(byP.get(m.priorityId) || []), m.elementId]);
    byE.set(m.elementId, [...(byE.get(m.elementId) || []), m.priorityId]);
  }

  const mappedP = new Set(local.map(m => m.priorityId));
  const mappedE = new Set(local.map(m => m.elementId));
  const gaps = sorted.filter(p => !mappedP.has(p.id));
  const orphans = elements.filter(e => !mappedE.has(e.id));

  // ─── Measure line positions ───
  const measure = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const cr = c.getBoundingClientRect();
    const out: LineData[] = [];

    for (const m of localRef.current) {
      const lEl = leftRefs.current.get(m.priorityId);
      const rEl = rightRefs.current.get(m.elementId);
      if (!lEl || !rEl) continue;

      const lr = lEl.getBoundingClientRect();
      const rr = rEl.getBoundingClientRect();

      const lConns = byP.get(m.priorityId) || [];
      const rConns = byE.get(m.elementId) || [];

      out.push({
        priorityId: m.priorityId,
        elementId: m.elementId,
        x1: lr.right - cr.left,
        y1: spreadY(lr.top - cr.top, lr.height, lConns.indexOf(m.elementId), lConns.length),
        x2: rr.left - cr.left,
        y2: spreadY(rr.top - cr.top, rr.height, rConns.indexOf(m.priorityId), rConns.length),
        color: color(m.priorityId),
      });
    }
    setLines(out);
  }, [local, color]);

  useLayoutEffect(() => {
    measure();
    const c = containerRef.current;
    if (!c) return;
    const obs = new ResizeObserver(measure);
    obs.observe(c);
    return () => obs.disconnect();
  }, [measure]);

  // ─── Update + notify parent ───
  function update(next: typeof local) {
    setLocal(next);
    onChange?.(next);
  }

  // ─── Delete a line ───
  function deleteLine(key: string) {
    const [pid, eid] = key.split(':');
    update(local.filter(m => !(m.priorityId === pid && m.elementId === eid)));
    setHoveredKey(null);
  }

  // ─── Drag from existing endpoint ───
  function endpointDown(e: React.MouseEvent, line: LineData, end: 'left' | 'right') {
    e.stopPropagation(); e.preventDefault();
    const cr = containerRef.current?.getBoundingClientRect();
    if (!cr) return;

    if (end === 'left') {
      // Dragging priority side → element end stays fixed
      setDrag({
        fromType: 'element', fromId: line.elementId,
        original: { priorityId: line.priorityId, elementId: line.elementId },
        fixedX: line.x2, fixedY: line.y2,
        mouseX: e.clientX - cr.left, mouseY: e.clientY - cr.top,
      });
    } else {
      // Dragging element side → priority end stays fixed
      setDrag({
        fromType: 'priority', fromId: line.priorityId,
        original: { priorityId: line.priorityId, elementId: line.elementId },
        fixedX: line.x1, fixedY: line.y1,
        mouseX: e.clientX - cr.left, mouseY: e.clientY - cr.top,
      });
    }
  }

  // ─── Drag from port (new connection) ───
  function portDown(e: React.MouseEvent, type: 'priority' | 'element', id: string) {
    e.stopPropagation(); e.preventDefault();
    const cr = containerRef.current?.getBoundingClientRect();
    if (!cr) return;
    const refs = type === 'priority' ? leftRefs : rightRefs;
    const el = refs.current.get(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = type === 'priority' ? r.right - cr.left : r.left - cr.left;
    const py = r.top + r.height / 2 - cr.top;

    setDrag({
      fromType: type, fromId: id, original: null,
      fixedX: px, fixedY: py,
      mouseX: e.clientX - cr.left, mouseY: e.clientY - cr.top,
    });
  }

  // ─── Hit-test for drop target ───
  function findTarget(cx: number, cy: number) {
    const d = dragRef.current;
    if (!d) return null;
    const refs = d.fromType === 'priority' ? rightRefs : leftRefs;
    for (const [id, el] of refs.current) {
      const r = el.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return id;
    }
    return null;
  }

  // ─── Global pointer handlers during drag ───
  useEffect(() => {
    if (!drag) return;

    function onMove(e: MouseEvent) {
      const cr = containerRef.current?.getBoundingClientRect();
      if (!cr) return;
      setDrag(prev => prev ? { ...prev, mouseX: e.clientX - cr.left, mouseY: e.clientY - cr.top } : null);
      setDropId(findTarget(e.clientX, e.clientY));
    }

    function onUp(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) { setDrag(null); return; }

      const tid = findTarget(e.clientX, e.clientY);
      if (tid) {
        const newPid = d.fromType === 'priority' ? d.fromId : tid;
        const newEid = d.fromType === 'priority' ? tid : d.fromId;

        let next = d.original
          ? localRef.current.filter(m => !(m.priorityId === d.original!.priorityId && m.elementId === d.original!.elementId))
          : [...localRef.current];

        if (!next.some(m => m.priorityId === newPid && m.elementId === newEid)) {
          next = [...next, { priorityId: newPid, elementId: newEid }];
        }
        update(next);
      }
      // No target → cancel (original stays)
      setDrag(null);
      setDropId(null);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [!!drag]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Touch support ───
  useEffect(() => {
    if (!drag) return;

    function onTouch(e: TouchEvent) {
      const t = e.touches[0];
      if (!t) return;
      e.preventDefault();
      const cr = containerRef.current?.getBoundingClientRect();
      if (!cr) return;
      setDrag(prev => prev ? { ...prev, mouseX: t.clientX - cr.left, mouseY: t.clientY - cr.top } : null);
      setDropId(findTarget(t.clientX, t.clientY));
    }

    function onTouchEnd(e: TouchEvent) {
      const t = e.changedTouches[0];
      if (!t) { setDrag(null); return; }
      const d = dragRef.current;
      if (!d) { setDrag(null); return; }

      const tid = findTarget(t.clientX, t.clientY);
      if (tid) {
        const newPid = d.fromType === 'priority' ? d.fromId : tid;
        const newEid = d.fromType === 'priority' ? tid : d.fromId;
        let next = d.original
          ? localRef.current.filter(m => !(m.priorityId === d.original!.priorityId && m.elementId === d.original!.elementId))
          : [...localRef.current];
        if (!next.some(m => m.priorityId === newPid && m.elementId === newEid)) {
          next = [...next, { priorityId: newPid, elementId: newEid }];
        }
        update(next);
      }
      setDrag(null);
      setDropId(null);
    }

    window.addEventListener('touchmove', onTouch, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    return () => {
      window.removeEventListener('touchmove', onTouch);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [!!drag]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Ref helpers ───
  const setL = (id: string) => (el: HTMLDivElement | null) => {
    if (el) leftRefs.current.set(id, el); else leftRefs.current.delete(id);
  };
  const setR = (id: string) => (el: HTMLDivElement | null) => {
    if (el) rightRefs.current.set(id, el); else rightRefs.current.delete(id);
  };

  // ─── Visible lines (hide the one being dragged) ───
  const visible = drag?.original
    ? lines.filter(l => !(l.priorityId === drag.original!.priorityId && l.elementId === drag.original!.elementId))
    : lines;

  // ─── Port position for a box ───
  function portPos(type: 'priority' | 'element', id: string) {
    const c = containerRef.current;
    if (!c) return null;
    const cr = c.getBoundingClientRect();
    const el = (type === 'priority' ? leftRefs : rightRefs).current.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: type === 'priority' ? r.right - cr.left : r.left - cr.left, y: r.top + r.height / 2 - cr.top };
  }

  // ─── Drag preview color ───
  const dragColor = drag
    ? color(drag.fromType === 'priority' ? drag.fromId : (drag.original?.priorityId || sorted[0]?.id || ''))
    : '';

  return (
    <div>
      <div className="mapping-diagram" ref={containerRef} style={{ cursor: drag ? 'grabbing' : undefined }}>
        <svg className="mapping-svg">
          {/* Connection lines */}
          {visible.map(l => {
            const key = `${l.priorityId}:${l.elementId}`;
            const hovered = hoveredKey === key;
            const d = curve(l.x1, l.y1, l.x2, l.y2);
            return (
              <g key={key}>
                {/* Fat invisible hit target */}
                <path d={d} fill="none" stroke="transparent" strokeWidth={14}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredKey(key)}
                  onMouseLeave={() => setHoveredKey(null)}
                  onClick={() => deleteLine(key)}
                />
                {/* Visible line */}
                <path d={d} fill="none" stroke={l.color}
                  strokeWidth={hovered ? 2.5 : 1.5}
                  strokeOpacity={hovered ? 0.85 : 0.45}
                  strokeLinecap="round"
                  style={{ pointerEvents: 'none', transition: 'stroke-width .15s, stroke-opacity .15s' }}
                />
                {/* Left endpoint */}
                <circle cx={l.x1} cy={l.y1} r={hovered ? 6 : 4.5}
                  fill={l.color} stroke="white" strokeWidth={1.5}
                  style={{ pointerEvents: 'auto', cursor: 'grab', transition: 'r .15s' }}
                  onMouseDown={e => endpointDown(e, l, 'left')}
                />
                {/* Right endpoint */}
                <circle cx={l.x2} cy={l.y2} r={hovered ? 6 : 4.5}
                  fill={l.color} stroke="white" strokeWidth={1.5}
                  style={{ pointerEvents: 'auto', cursor: 'grab', transition: 'r .15s' }}
                  onMouseDown={e => endpointDown(e, l, 'right')}
                />
                {/* Hover hint */}
                {hovered && (
                  <text x={(l.x1 + l.x2) / 2} y={(l.y1 + l.y2) / 2 - 10}
                    textAnchor="middle" fill={l.color} fontSize={11} fontWeight={500}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >click to remove</text>
                )}
              </g>
            );
          })}

          {/* Port dots for unconnected boxes */}
          {sorted.filter(p => !mappedP.has(p.id)).map(p => {
            const pos = portPos('priority', p.id);
            if (!pos) return null;
            return (
              <circle key={`pp-${p.id}`} cx={pos.x} cy={pos.y} r={4}
                fill="var(--border)" stroke="white" strokeWidth={1}
                style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
                onMouseDown={e => portDown(e, 'priority', p.id)}
              />
            );
          })}
          {elements.filter(e => !mappedE.has(e.id)).map(el => {
            const pos = portPos('element', el.id);
            if (!pos) return null;
            return (
              <circle key={`pe-${el.id}`} cx={pos.x} cy={pos.y} r={4}
                fill="var(--border)" stroke="white" strokeWidth={1}
                style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
                onMouseDown={e => portDown(e, 'element', el.id)}
              />
            );
          })}

          {/* Invisible port targets on connected boxes (for creating additional connections) */}
          {sorted.filter(p => mappedP.has(p.id)).map(p => {
            const pos = portPos('priority', p.id);
            if (!pos) return null;
            return (
              <circle key={`ppc-${p.id}`} cx={pos.x} cy={pos.y} r={6}
                fill="transparent"
                style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
                onMouseDown={e => portDown(e, 'priority', p.id)}
              />
            );
          })}
          {elements.filter(e => mappedE.has(e.id)).map(el => {
            const pos = portPos('element', el.id);
            if (!pos) return null;
            return (
              <circle key={`pec-${el.id}`} cx={pos.x} cy={pos.y} r={6}
                fill="transparent"
                style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
                onMouseDown={e => portDown(e, 'element', el.id)}
              />
            );
          })}

          {/* Drag preview line */}
          {drag && (() => {
            const [x1, y1, x2, y2] = drag.fromType === 'priority'
              ? [drag.fixedX, drag.fixedY, drag.mouseX, drag.mouseY]
              : [drag.mouseX, drag.mouseY, drag.fixedX, drag.fixedY];
            return (
              <path d={curve(x1, y1, x2, y2)} fill="none" stroke={dragColor}
                strokeWidth={1.5} strokeOpacity={0.6} strokeDasharray="6 4"
                strokeLinecap="round" style={{ pointerEvents: 'none' }}
              />
            );
          })()}
        </svg>

        {/* Left column: priorities */}
        <div className="mapping-col">
          <div className="mapping-col-header">{audienceName}'s Priorities</div>
          {sorted.map(p => {
            const c = color(p.id);
            const isDrop = dropId === p.id;
            return (
              <div key={p.id} ref={setL(p.id)}
                className="mapping-node mapping-node-priority"
                style={{
                  borderLeftColor: c,
                  background: isDrop ? rgba(c, 0.08) : rgba(c, 0.04),
                  ...(isDrop ? { boxShadow: `0 0 0 2px ${c}` } : {}),
                }}
              >
                <span className="mapping-node-rank" style={{ color: c }}>#{p.rank}</span>
                <span className="mapping-node-text">{p.text}</span>
              </div>
            );
          })}
        </div>

        {/* Right column: capabilities */}
        <div className="mapping-col">
          <div className="mapping-col-header">{offeringName}'s Capabilities</div>
          {elements.map(el => {
            const isDrop = dropId === el.id;
            const connColors = (byE.get(el.id) || []).map(pid => color(pid));
            const highlight = drag?.fromType === 'priority' ? color(drag.fromId) : connColors[0] || 'var(--border)';
            return (
              <div key={el.id} ref={setR(el.id)}
                className="mapping-node mapping-node-element"
                style={isDrop ? { boxShadow: `0 0 0 2px ${highlight}`, background: rgba(highlight, 0.06) } : {}}
              >
                {connColors.length > 0 && (
                  <span className="mapping-dots">
                    {connColors.map((c, i) => (
                      <span key={i} className="mapping-dot" style={{ background: c }} />
                    ))}
                  </span>
                )}
                <span className="mapping-node-text">{el.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      {(gaps.length > 0 || orphans.length > 0) && (
        <div className="mapping-footer">
          {gaps.length > 0 && (
            <div className="mapping-footer-section">
              <strong>Gaps</strong>
              <span className="mapping-footer-label">Priorities without a match</span>
              {gaps.map(g => (
                <div key={g.id} className="mapping-footer-item">
                  <span className="mapping-dot" style={{ background: color(g.id), opacity: 0.4 }} />
                  {g.text}
                </div>
              ))}
            </div>
          )}
          {orphans.length > 0 && (
            <div className="mapping-footer-section">
              <strong>Unmapped</strong>
              <span className="mapping-footer-label">Capabilities not tied to a priority</span>
              {orphans.map(o => (
                <div key={o.id} className="mapping-footer-item">
                  <span className="mapping-dot" style={{ background: 'var(--border)' }} />
                  {o.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

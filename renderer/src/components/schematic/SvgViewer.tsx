import { useCallback, useRef, useState } from 'react';

interface Props {
  svgContent: string;
}

export function SvgViewer({ svgContent }: Props) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale((prev) => Math.max(0.25, Math.min(4, prev + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setDragging(true);
    dragStart.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  }, [offset]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setOffset({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const handleSave = useCallback(async () => {
    if (!window.electronAPI) return;
    // We can't easily save SVG through the IPC but can use a download approach
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'schematic.svg';
    a.click();
    URL.revokeObjectURL(url);
  }, [svgContent]);

  if (!svgContent) {
    return (
      <div style={styles.empty}>
        <p>No schematic generated. Complete the rendering stage to see the SVG.</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={styles.label}>Schematic</span>
        <div style={styles.toolGroup}>
          <button onClick={() => setScale((s) => Math.min(4, s + 0.25))} style={styles.btn}>+</button>
          <span style={styles.scaleText}>{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.max(0.25, s - 0.25))} style={styles.btn}>−</button>
          <button onClick={resetView} style={styles.btn}>Fit</button>
          <button onClick={handleSave} style={styles.saveBtn}>Export SVG</button>
        </div>
      </div>
      <div
        ref={containerRef}
        style={{ ...styles.viewport, cursor: dragging ? 'grabbing' : 'grab' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          style={{
            ...styles.svgWrapper,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: '0 0',
          }}
          dangerouslySetInnerHTML={{ __html: svgContent }}
        />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 16px',
    backgroundColor: '#16213e',
    borderBottom: '1px solid #0f3460',
  },
  label: { fontSize: 12, color: '#a0a0b0' },
  toolGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  btn: {
    background: '#1a1a2e',
    color: '#e0e0e0',
    border: '1px solid #0f3460',
    borderRadius: 4,
    padding: '2px 10px',
    cursor: 'pointer',
    fontSize: 14,
  },
  scaleText: { fontSize: 12, color: '#a0a0b0', minWidth: 44, textAlign: 'center' },
  saveBtn: {
    padding: '4px 14px',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    marginLeft: 8,
  },
  viewport: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#0d1117',
    position: 'relative',
  },
  svgWrapper: {
    position: 'absolute',
    left: 20,
    top: 20,
    backgroundColor: '#ffffff',
    borderRadius: 4,
    boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    padding: 16,
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
  },
};

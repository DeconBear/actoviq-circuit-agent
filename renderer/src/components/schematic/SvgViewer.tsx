import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';

export function SvgViewer() {
  const svgContent = useAppStore((s) => s.svgContent);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);

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

  const fitView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !svgContent) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const dimensions = getSvgDimensions(svgContent);
    const nextScale = Math.max(
      0.25,
      Math.min(4, Math.min((rect.width - 80) / dimensions.width, (rect.height - 80) / dimensions.height)),
    );
    setScale(nextScale);
    setOffset({
      x: Math.max(0, (rect.width - dimensions.width * nextScale) / 2 - 20),
      y: Math.max(0, (rect.height - dimensions.height * nextScale) / 2 - 20),
    });
  }, [svgContent]);

  useEffect(() => {
    fitView();
  }, [fitView]);

  const handleExport = useCallback(() => {
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
        <div style={styles.emptyIcon}>📐</div>
        <div style={styles.emptyTitle}>No Schematic Generated</div>
        <div style={styles.emptyDesc}>
          Complete the rendering stage to see the SVG schematic.<br />
          You can pan and zoom the schematic once generated.
        </div>
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
          <button onClick={() => setScale((s) => Math.max(0.25, s - 0.25))} style={styles.btn}>-</button>
          <button onClick={fitView} style={styles.btn}>Fit</button>
          <button onClick={handleExport} style={styles.saveBtn}>Export SVG</button>
        </div>
      </div>
      <div
        ref={viewportRef}
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
          dangerouslySetInnerHTML={{ __html: sanitizeSvg(svgContent) }}
        />
      </div>
    </div>
  );
}

function sanitizeSvg(svg: string): string {
  // Remove script tags and event handlers for safety
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*["']\s*javascript:[^"']*["']/gi, '');
}

function parseSvgLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getSvgDimensions(svg: string): { width: number; height: number } {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    const viewBox = root.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
    const width = viewBox?.[2];
    const height = viewBox?.[3];
    if (
      viewBox?.length === 4 &&
      typeof width === 'number' &&
      typeof height === 'number' &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      return { width, height };
    }
    return {
      width: parseSvgLength(root.getAttribute('width')) ?? 800,
      height: parseSvgLength(root.getAttribute('height')) ?? 600,
    };
  } catch {
    return { width: 800, height: 600 };
  }
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
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
    gap: 8,
  },
  emptyIcon: { fontSize: 40, opacity: 0.4 },
  emptyTitle: { fontSize: 16, fontWeight: 600, color: '#808090' },
  emptyDesc: { fontSize: 13, color: '#505060', textAlign: 'center', lineHeight: 1.6 },
};

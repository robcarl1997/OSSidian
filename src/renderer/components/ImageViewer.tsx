import { useState, useRef, useCallback, useEffect } from 'react';

interface ImageViewerProps {
  path: string;      // absolute path
  vaultPath: string;
  onClose: () => void;
}

export default function ImageViewer({ path, vaultPath, onClose }: ImageViewerProps) {
  const [zoom, setZoom]   = useState(1);
  const [fit, setFit]     = useState(true);
  const [pan, setPan]     = useState({ x: 0, y: 0 });
  const bodyRef           = useRef<HTMLDivElement>(null);
  const dragging          = useRef(false);
  const lastPos           = useRef({ x: 0, y: 0 });

  const name    = path.split('/').pop() ?? path;
  const relPath = path.startsWith(vaultPath + '/') ? path.slice(vaultPath.length + 1) : path;
  const src     = `vault://${relPath}`;

  const enterZoom = useCallback((newZoom: number) => {
    setFit(false);
    setZoom(Math.min(Math.max(newZoom, 0.1), 10));
  }, []);

  const zoomIn  = () => enterZoom(zoom + 0.25);
  const zoomOut = () => enterZoom(zoom - 0.25);
  const reset   = () => { setFit(true); setZoom(1); setPan({ x: 0, y: 0 }); };

  // Mouse wheel zoom
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      setFit(false);
      setZoom(z => Math.min(Math.max(z + delta * z, 0.1), 10));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag to pan
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (fit) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  }, [fit]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };
      setPan(p => ({ x: p.x + dx, y: p.y + dy }));
    };
    const onMouseUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div className="image-viewer">
      <div className="image-viewer-header">
        <span className="image-viewer-name">🖼️ {name}</span>
        <div className="image-viewer-controls">
          <button className="image-viewer-btn" onClick={zoomOut} title="Verkleinern">−</button>
          <button className="image-viewer-btn" onClick={reset}   title="Einpassen">
            {fit ? '⊡' : `${Math.round(zoom * 100)}%`}
          </button>
          <button className="image-viewer-btn" onClick={zoomIn}  title="Vergrößern">+</button>
        </div>
        <button className="image-viewer-close" onClick={onClose} title="Schließen">✕</button>
      </div>

      <div
        ref={bodyRef}
        className={`image-viewer-body${fit ? ' image-viewer-body--fit' : ''}`}
        onMouseDown={onMouseDown}
        style={fit ? {} : { cursor: dragging.current ? 'grabbing' : 'grab' }}
      >
        <img
          src={src}
          alt={name}
          className="image-viewer-img"
          draggable={false}
          style={fit
            ? {}
            : {
                width: `${zoom * 100}%`,
                transform: `translate(${pan.x}px, ${pan.y}px)`,
                transformOrigin: 'center center',
                userSelect: 'none',
              }
          }
        />
      </div>
    </div>
  );
}

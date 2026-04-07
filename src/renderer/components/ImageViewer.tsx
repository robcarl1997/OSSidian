import { useState } from 'react';

interface ImageViewerProps {
  path: string;      // absolute path
  vaultPath: string;
  onClose: () => void;
}

export default function ImageViewer({ path, vaultPath, onClose }: ImageViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [fit, setFit]   = useState(true);

  const name    = path.split('/').pop() ?? path;
  const relPath = path.startsWith(vaultPath + '/') ? path.slice(vaultPath.length + 1) : path;
  const src     = `vault://${relPath}`;

  const zoomIn  = () => { setFit(false); setZoom(z => Math.min(z + 0.25, 5)); };
  const zoomOut = () => { setFit(false); setZoom(z => Math.max(z - 0.25, 0.25)); };
  const reset   = () => { setFit(true);  setZoom(1); };

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

      <div className={`image-viewer-body${fit ? ' image-viewer-body--fit' : ''}`}>
        <img
          src={src}
          alt={name}
          className="image-viewer-img"
          style={fit ? {} : { width: `${zoom * 100}%` }}
          draggable={false}
        />
      </div>
    </div>
  );
}

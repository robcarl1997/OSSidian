interface PdfViewerProps {
  path: string;      // absolute path
  vaultPath: string;
  onClose: () => void;
}

export default function PdfViewer({ path, vaultPath, onClose }: PdfViewerProps) {
  const name    = path.split('/').pop() ?? path;
  const relPath = path.startsWith(vaultPath + '/') ? path.slice(vaultPath.length + 1) : path;
  const src     = `vault://${relPath}`;

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer-header">
        <span className="pdf-viewer-name">📋 {name}</span>
        <button className="pdf-viewer-close" onClick={onClose} title="Schließen">✕</button>
      </div>
      <iframe
        src={src}
        className="pdf-viewer-frame"
        title={name}
      />
    </div>
  );
}

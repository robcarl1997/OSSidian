import { useEffect, useRef, useCallback, useState } from 'react';
import { parseWikilinks, findPathByStem } from '../../../shared/linking';

// ─── Types ──────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string;       // vault-relative path
  name: string;     // display name (filename without .md)
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

interface GraphEdge {
  source: string;   // node id
  target: string;   // node id
}

interface GraphViewProps {
  allPaths: string[];
  activePath: string | null;
  vaultPath: string;
  onOpenNote: (path: string) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stemFromPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  const name = parts[parts.length - 1] ?? '';
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

// ─── Force-directed layout ─────────────────────────────────────────────────

function simulate(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
  iterations: number,
): void {
  const REPULSION = 2000;
  const ATTRACTION = 0.005;
  const CENTER_FORCE = 0.008;
  const DAMPING = 0.85;
  const MAX_VEL = 10;

  // Build adjacency for quick lookup
  const edgeSet = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!edgeSet.has(e.source)) edgeSet.set(e.source, new Set());
    if (!edgeSet.has(e.target)) edgeSet.set(e.target, new Set());
    edgeSet.get(e.source)!.add(e.target);
    edgeSet.get(e.target)!.add(e.source);
  }

  const cx = width / 2;
  const cy = height / 2;

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsion (Coulomb)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < 1) dist = 1;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
        if (!b.pinned) { b.vx += fx; b.vy += fy; }
      }
    }

    // Attraction (spring along edges)
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    for (const e of edges) {
      const a = nodeMap.get(e.source);
      const b = nodeMap.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = dist * ATTRACTION;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.pinned) { a.vx += fx; a.vy += fy; }
      if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
    }

    // Center gravity + damping + position update
    for (const n of nodes) {
      if (n.pinned) continue;
      n.vx += (cx - n.x) * CENTER_FORCE;
      n.vy += (cy - n.y) * CENTER_FORCE;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      // Clamp velocity
      const v = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (v > MAX_VEL) { n.vx = (n.vx / v) * MAX_VEL; n.vy = (n.vy / v) * MAX_VEL; }
      n.x += n.vx;
      n.y += n.vy;
    }
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function GraphView({ allPaths, activePath, vaultPath: _vaultPath, onOpenNote }: GraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{ nodeId: string | null; panning: boolean; lastX: number; lastY: number }>({
    nodeId: null, panning: false, lastX: 0, lastY: 0,
  });
  const rafRef = useRef<number>(0);
  const [loading, setLoading] = useState(true);
  const linkedNodesRef = useRef<Set<string>>(new Set());
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // ─── Build graph data ──────────────────────────────────────────────────

  const buildGraph = useCallback(async () => {
    setLoading(true);
    const mdPaths = allPaths.filter(p => p.endsWith('.md'));
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const edgeSet = new Set<string>();

    // Create nodes
    const w = containerRef.current?.clientWidth ?? 800;
    const h = containerRef.current?.clientHeight ?? 600;
    for (const p of mdPaths) {
      nodes.push({
        id: p,
        name: stemFromPath(p),
        x: w / 2 + (Math.random() - 0.5) * w * 0.8,
        y: h / 2 + (Math.random() - 0.5) * h * 0.8,
        vx: 0,
        vy: 0,
        pinned: false,
      });
    }

    // Load content and extract links
    const BATCH = 20;
    for (let i = 0; i < mdPaths.length; i += BATCH) {
      const batch = mdPaths.slice(i, i + BATCH);
      const docs = await Promise.all(
        batch.map(p => window.vaultApp.openNote(p).catch(() => null))
      );
      for (let j = 0; j < batch.length; j++) {
        const doc = docs[j];
        if (!doc) continue;
        const links = parseWikilinks(doc.raw);
        for (const link of links) {
          const targetPath = findPathByStem(link.target, allPaths, batch[j]);
          if (!targetPath || targetPath === batch[j]) continue;
          const key = [batch[j], targetPath].sort().join('::');
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ source: batch[j], target: targetPath });
          }
        }
      }
    }

    // Compute linked nodes for active note highlighting
    const linked = new Set<string>();
    if (activePath) {
      for (const e of edges) {
        if (e.source === activePath) linked.add(e.target);
        if (e.target === activePath) linked.add(e.source);
      }
    }
    linkedNodesRef.current = linked;

    // Run simulation
    simulate(nodes, edges, w, h, 300);

    nodesRef.current = nodes;
    edgesRef.current = edges;

    // Center transform
    transformRef.current = { x: 0, y: 0, scale: 1 };

    setLoading(false);
  }, [allPaths, activePath]);

  useEffect(() => {
    buildGraph();
  }, [buildGraph]);

  // ─── Update linked-nodes when activePath changes ──────────────────────

  useEffect(() => {
    const linked = new Set<string>();
    if (activePath) {
      for (const e of edgesRef.current) {
        if (e.source === activePath) linked.add(e.target);
        if (e.target === activePath) linked.add(e.source);
      }
    }
    linkedNodesRef.current = linked;
  }, [activePath]);

  // ─── Rendering ────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Read CSS variables from the container
    const container = containerRef.current;
    const style = container ? getComputedStyle(container) : null;
    const bgColor = style?.getPropertyValue('--bg-app').trim() || '#1e1e2e';
    const borderColor = style?.getPropertyValue('--border').trim() || '#313244';
    const textMuted = style?.getPropertyValue('--text-muted').trim() || '#a6adc8';
    const accentColor = style?.getPropertyValue('--accent').trim() || '#cba6f7';
    const accentDim = style?.getPropertyValue('--accent-dim').trim() || '#9874c5';
    const textPrimary = style?.getPropertyValue('--text-primary').trim() || '#cdd6f4';

    // Clear
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    const t = transformRef.current;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);

    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const active = activePathRef.current;
    const linked = linkedNodesRef.current;

    // Draw edges
    ctx.lineWidth = 1.5 / t.scale;
    for (const e of edges) {
      const a = nodeMap.get(e.source);
      const b = nodeMap.get(e.target);
      if (!a || !b) continue;
      const isActiveEdge = active && (e.source === active || e.target === active);
      ctx.strokeStyle = isActiveEdge ? accentDim : borderColor;
      ctx.globalAlpha = isActiveEdge ? 0.9 : 0.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Draw nodes
    const NODE_RADIUS = 5;
    const fontSize = Math.max(9, 11 / t.scale);
    ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';

    for (const n of nodes) {
      const isActive = n.id === active;
      const isLinked = linked.has(n.id);

      // Node circle
      ctx.beginPath();
      const r = isActive ? NODE_RADIUS * 1.5 : NODE_RADIUS;
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? accentColor : isLinked ? accentDim : textMuted;
      ctx.fill();

      // Label
      ctx.fillStyle = isActive ? textPrimary : textMuted;
      ctx.globalAlpha = isActive ? 1 : isLinked ? 0.9 : 0.7;
      ctx.fillText(n.name, n.x, n.y + r + fontSize + 2);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }, []);

  // ─── Animation loop ──────────────────────────────────────────────────

  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, [draw]);

  // ─── Interaction: find node under cursor ──────────────────────────────

  const nodeAt = useCallback((clientX: number, clientY: number): GraphNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const t = transformRef.current;
    const mx = (clientX - rect.left - t.x) / t.scale;
    const my = (clientY - rect.top - t.y) / t.scale;
    const HIT = 12;
    for (const n of nodesRef.current) {
      const dx = n.x - mx;
      const dy = n.y - my;
      if (dx * dx + dy * dy < HIT * HIT) return n;
    }
    return null;
  }, []);

  // ─── Mouse handlers ──────────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const node = nodeAt(e.clientX, e.clientY);
    if (node) {
      dragRef.current = { nodeId: node.id, panning: false, lastX: e.clientX, lastY: e.clientY };
      node.pinned = true;
    } else {
      dragRef.current = { nodeId: null, panning: true, lastX: e.clientX, lastY: e.clientY };
    }
  }, [nodeAt]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d.panning && !d.nodeId) return;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;

    if (d.panning) {
      transformRef.current.x += dx;
      transformRef.current.y += dy;
    } else if (d.nodeId) {
      const t = transformRef.current;
      const node = nodesRef.current.find(n => n.id === d.nodeId);
      if (node) {
        node.x += dx / t.scale;
        node.y += dy / t.scale;
      }
    }
  }, []);

  // Track starting position for click detection
  const mouseDownPos = useRef({ x: 0, y: 0 });
  const onMouseDownWrapped = useCallback((e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
    onMouseDown(e);
  }, [onMouseDown]);

  const onMouseUpWrapped = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (d.nodeId) {
      const node = nodesRef.current.find(n => n.id === d.nodeId);
      const totalDist = Math.abs(e.clientX - mouseDownPos.current.x) + Math.abs(e.clientY - mouseDownPos.current.y);
      if (node) {
        node.pinned = false;
        if (totalDist < 5) {
          onOpenNote(node.id);
        }
      }
    }
    dragRef.current = { nodeId: null, panning: false, lastX: 0, lastY: 0 };
  }, [onOpenNote]);

  // ─── Wheel zoom ──────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const t = transformRef.current;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(0.1, Math.min(5, t.scale * factor));
      // Zoom towards cursor
      t.x = mx - (mx - t.x) * (newScale / t.scale);
      t.y = my - (my - t.y) * (newScale / t.scale);
      t.scale = newScale;
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // ─── Resize observer ─────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => { /* re-draw handled by animation loop */ });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────

  const nodeCount = nodesRef.current.length;
  const edgeCount = edgesRef.current.length;

  return (
    <div className="graph-view" ref={containerRef} data-testid="graph-view">
      <div className="graph-view-header">
        <span className="graph-view-title">Graph-Ansicht</span>
        <span className="graph-view-stats">
          {loading ? 'Lade...' : `${nodeCount} Notizen · ${edgeCount} Verknüpfungen`}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="graph-view-canvas"
        onMouseDown={onMouseDownWrapped}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUpWrapped}
      />
    </div>
  );
}

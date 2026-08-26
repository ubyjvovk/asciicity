/**
 * Traffic — double-decker buses driving the primary/secondary road network
 * as pure ambience (docs/architecture.md §5, docs/world.md §Traffic).
 * `buildRoadGraph` reduces roads to an endpoint adjacency graph; `PathWalker`
 * wanders one edge polyline at constant speed, turning onto a random other
 * edge at each node (or reversing at a dead end); `BusFleet` wraps `count`
 * walkers in a single `THREE.InstancedMesh` with no per-frame allocation.
 */
import * as THREE from 'three';
import { mulberry32 } from '../data/synthetic';
import { FLAT_HEIGHT } from '../data/types';
import type { HeightFn, Road, RoadClass, Vec2 } from '../data/types';

/** Metres driven per second by every bus. */
const BUS_SPEED_MPS = 7;

/** Metres sailed per second by every boat. */
const BOAT_SPEED_MPS = 4;

/** Height (centre) of a boat above the water line (geometry is 2 m tall). */
const BOAT_Y = 1.0;

/** Road classes that carry double-deckers. */
const BUS_CLASSES: RoadClass[] = ['primary', 'secondary'];

/** Body height of a double-decker (m); half of it becomes the centre height. */
const BUS_HEIGHT = 4.3;
const BUS_HALF_HEIGHT = BUS_HEIGHT / 2;

/** Endpoint node graph of a road network. Nodes are quantised 2 m endpoints. */
export interface RoadGraph {
  /** Node key "x,z" → quantised endpoint coordinate. */
  nodes: Map<string, Vec2>;
  /** Kept roads, each its full polyline plus quantised endpoint keys. */
  edges: { pts: Vec2[]; a: string; b: string }[];
  /** Node key → indices of the edges touching it (at either end). */
  adj: Map<string, number[]>;
}

/**
 * Quantise a coordinate to the 2 m grid used for node keys.
 * `Math.round(v / 2) * 2` per the ticket.
 */
function quantise(v: number): number {
  return Math.round(v / 2) * 2;
}

/** "x,z" key for a quantised [x, z] endpoint. */
function keyOf(x: number, z: number): string {
  return `${x},${z}`;
}

/** Total length (m) of a polyline. */
function polylineLength(pts: Vec2[]): number {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  return len;
}

/**
 * Build the endpoint node graph: keep roads whose class is in `classes` with
 * at least two distinct points, node keys from quantised endpoints, and an
 * adjacency map from each node to the edge indices touching it.
 */
export function buildRoadGraph(roads: Road[], classes: RoadClass[]): RoadGraph {
  const nodes = new Map<string, Vec2>();
  const edges: RoadGraph['edges'] = [];
  const adj = new Map<string, number[]>();
  for (const road of roads) {
    if (!classes.includes(road.cls)) continue;
    if (road.pts.length < 2) continue;
    if (polylineLength(road.pts) === 0) continue; // degenerate way can't be walked
    const first = road.pts[0];
    const last = road.pts[road.pts.length - 1];
    const ax = quantise(first[0]);
    const az = quantise(first[1]);
    const bx = quantise(last[0]);
    const bz = quantise(last[1]);
    const a = keyOf(ax, az);
    const b = keyOf(bx, bz);
    const edgeIndex = edges.length;
    edges.push({ pts: road.pts, a, b });
    if (!nodes.has(a)) nodes.set(a, [ax, az]);
    if (!nodes.has(b)) nodes.set(b, [bx, bz]);
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(edgeIndex);
    if (a !== b) {
      if (!adj.has(b)) adj.set(b, []);
      adj.get(b)!.push(edgeIndex);
    }
  }
  return { nodes, edges, adj };
}

/**
 * One bus: walks a random edge polyline at constant speed on the graph,
 * turning onto a random other edge at each node (or reversing at dead ends).
 * `x`/`z` are the current position; `heading` the current segment yaw.
 */
export class PathWalker {
  /** The road graph this bus wanders. */
  readonly graph: RoadGraph;
  private rand: () => number;
  private _x = 0;
  private _z = 0;
  private _heading = 0;
  private edgeIndex = 0;
  private dir: 1 | -1 = 1;
  /** When true, reverse at polyline ends instead of turning onto other edges. */
  private reverseAtEnds: boolean;
  /** Metres walked along the current edge polyline from its starting end. */
  private dist = 0;

  /** Current x (east) position in metres. */
  get x(): number {
    return this._x;
  }
  /** Current z (south) position in metres. */
  get z(): number {
    return this._z;
  }
  /** Current segment yaw: `atan2(dx, −dz)` (0 faces north, +π/2 east). */
  get heading(): number {
    return this._heading;
  }

  /**
   * Start on a random edge, at a random point along it. The empty graph has
   * no edges, so the walker is inert (position 0, heading 0). When
   * `reverseAtEnds` is true the walker never turns onto other edges — it
   * reverses direction at every polyline end (used by boats on isolated
   * river centre-lines).
   */
  constructor(graph: RoadGraph, rand: () => number, reverseAtEnds = false) {
    this.graph = graph;
    this.rand = rand;
    this.reverseAtEnds = reverseAtEnds;
    if (graph.edges.length === 0) return;
    this.edgeIndex = Math.floor(rand() * graph.edges.length);
    this.dist = rand() * polylineLength(graph.edges[this.edgeIndex].pts);
    this.recompute();
  }

  /**
   * Advance the bus `dtMetres` metres along the network. Walkers move exactly
   * that distance; at an edge end they pick a random other edge from the
   * node's adjacency (or reverse when the node is a dead end).
   */
  advance(dtMetres: number): void {
    let remaining = dtMetres;
    while (remaining > 0) {
      const edge = this.graph.edges[this.edgeIndex];
      const total = polylineLength(edge.pts);
      const toEnd = total - this.dist;
      if (remaining < toEnd) {
        this.dist += remaining;
        remaining = 0;
      } else {
        remaining -= toEnd;
        this.dist = total;
        this.turn();
      }
    }
    this.recompute();
  }

  /** At the reached end node, pick a random other edge, or reverse. */
  private turn(): void {
    // Boats on isolated centre-lines always ping-pong: no graph turns.
    if (this.reverseAtEnds) {
      this.dir = this.dir === 1 ? -1 : 1;
      this.dist = 0;
      return;
    }
    const edge = this.graph.edges[this.edgeIndex];
    const endKey = this.dir === 1 ? edge.b : edge.a;
    const candidates = (this.graph.adj.get(endKey) ?? []).filter(
      (i) => i !== this.edgeIndex,
    );
    if (candidates.length > 0) {
      const chosen = candidates[Math.floor(this.rand() * candidates.length)];
      const next = this.graph.edges[chosen];
      this.dir = next.a === endKey ? 1 : -1;
      this.edgeIndex = chosen;
      this.dist = 0;
    } else {
      this.dir = this.dir === 1 ? -1 : 1;
      this.dist = 0;
    }
  }

  /** Recompute x/z/heading from the current edge, direction and distance. */
  private recompute(): void {
    const pts = this.graph.edges[this.edgeIndex].pts;
    const s = this.dist;
    if (this.dir === 1) {
      // Walk from pts[0] toward the end.
      let cum = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const heading = Math.atan2(q[0] - p[0], -(q[1] - p[1]));
        if (len === 0) continue;
        if (s <= cum + len) {
          const t = len === 0 ? 0 : (s - cum) / len;
          this._x = p[0] + (q[0] - p[0]) * t;
          this._z = p[1] + (q[1] - p[1]) * t;
          this._heading = heading;
          return;
        }
        cum += len;
      }
      // s beyond the polyline: clamp at the last point.
      const last = pts[pts.length - 1];
      this._x = last[0];
      this._z = last[1];
    } else {
      // Walk from pts[last] back toward the start.
      let cum = 0;
      for (let i = pts.length - 1; i > 0; i--) {
        const p = pts[i];
        const q = pts[i - 1];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const heading = Math.atan2(q[0] - p[0], -(q[1] - p[1]));
        if (len === 0) continue;
        if (s <= cum + len) {
          const t = len === 0 ? 0 : (s - cum) / len;
          this._x = p[0] + (q[0] - p[0]) * t;
          this._z = p[1] + (q[1] - p[1]) * t;
          this._heading = heading;
          return;
        }
        cum += len;
      }
      // s beyond the polyline: clamp at the first point.
      const first = pts[0];
      this._x = first[0];
      this._z = first[1];
    }
  }
}

/**
 * A dozen red double-deckers on the primary/secondary roads, rendered as one
 * instanced mesh. Empty network → `count 0` and an inert object whose
 * `update` is a no-op.
 */
export class BusFleet {
  /** The three.js object to add to the scene (an InstancedMesh, or a Group when idle). */
  readonly object: THREE.Object3D;
  /** Number of buses currently driving (0 when no matching roads exist). */
  readonly count: number;
  private walkers: PathWalker[];
  private mesh: THREE.InstancedMesh | null;
  private dummy: THREE.Object3D;
  private readonly heightAt: HeightFn;

  /**
   * Build `count` walkers over the primary/secondary road graph and a matching
   * instanced double-decker mesh. A graph with no edges yields `count 0`.
   * `heightAt` is sampled in `update()` to seat each bus on the ground; the
   * default `FLAT_HEIGHT` keeps the flat world at `y = BUS_HALF_HEIGHT`.
   */
  constructor(roads: Road[], count = 12, seed = 9, heightAt: HeightFn = FLAT_HEIGHT) {
    this.heightAt = heightAt;
    const graph = buildRoadGraph(roads, BUS_CLASSES);
    const n = graph.edges.length > 0 ? count : 0;
    this.count = n;
    this.dummy = new THREE.Object3D();
    if (n === 0) {
      this.walkers = [];
      this.mesh = null;
      this.object = new THREE.Group();
      return;
    }
    this.walkers = [];
    for (let i = 0; i < n; i++) {
      this.walkers.push(new PathWalker(graph, mulberry32(seed + i)));
    }
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.5, BUS_HEIGHT, 10.2),
      new THREE.MeshLambertMaterial({ color: 0xc0392b }),
      n,
    );
    this.mesh = mesh;
    this.object = mesh;
  }

  /**
   * Advance every bus by `dt · speed` metres and write its matrix via a single
   * reused dummy — no per-frame allocation. No-op when no buses exist.
   */
  update(dt: number): void {
    if (this.walkers.length === 0) return;
    for (let i = 0; i < this.walkers.length; i++) {
      const w = this.walkers[i];
      w.advance(dt * BUS_SPEED_MPS);
      this.dummy.position.set(w.x, this.heightAt(w.x, w.z) + BUS_HALF_HEIGHT, w.z);
      this.dummy.rotation.y = -w.heading;
      this.dummy.updateMatrix();
      this.mesh!.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh!.instanceMatrix.needsUpdate = true;
  }
}

/**
 * A few grey boats gliding along the OSM river centre-lines, rendered as one
 * instanced mesh. Each walker ping-pongs along a randomly chosen polyline,
 * reversing at the ends (no graph). Empty/absent rivers → `count 0` and an
 * inert object whose `update` is a no-op.
 */
export class BoatFleet {
  /** The three.js object to add to the scene (an InstancedMesh, or a Group when idle). */
  readonly object: THREE.Object3D;
  /** Number of boats currently sailing (0 when no valid rivers exist). */
  readonly count: number;
  private walkers: PathWalker[];
  private mesh: THREE.InstancedMesh | null;
  private dummy: THREE.Object3D;
  private readonly heightAt: HeightFn;

  /**
   * Build `count` ping-pong walkers over the river centre-lines and a matching
   * instanced boat mesh. Rivers are treated as isolated edges (no inter-river
   * connections), so each boat stays on one polyline and reverses at its ends.
   * `heightAt` is sampled in `update()` to seat each boat on the water; the
   * default `FLAT_HEIGHT` keeps the flat world at `y = BOAT_Y`. No valid rivers
   * → `count 0`.
   */
  constructor(rivers: Vec2[][], count = 4, seed = 17, heightAt: HeightFn = FLAT_HEIGHT) {
    this.heightAt = heightAt;
    const graph = buildRoadGraph(
      rivers.map((pts, i) => ({ id: i, cls: 'primary' as RoadClass, pts })),
      ['primary'],
    );
    const n = graph.edges.length > 0 ? count : 0;
    this.count = n;
    this.dummy = new THREE.Object3D();
    if (n === 0) {
      this.walkers = [];
      this.mesh = null;
      this.object = new THREE.Group();
      return;
    }
    this.walkers = [];
    for (let i = 0; i < n; i++) {
      this.walkers.push(new PathWalker(graph, mulberry32(seed + i), true));
    }
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(4, 2, 14),
      new THREE.MeshLambertMaterial({ color: 0xbfc8cc }),
      n,
    );
    this.mesh = mesh;
    this.object = mesh;
  }

  /**
   * Advance every boat by `dt · speed` metres and write its matrix via a single
   * reused dummy — no per-frame allocation. No-op when no boats exist.
   */
  update(dt: number): void {
    if (this.walkers.length === 0) return;
    for (let i = 0; i < this.walkers.length; i++) {
      const w = this.walkers[i];
      w.advance(dt * BOAT_SPEED_MPS);
      this.dummy.position.set(w.x, this.heightAt(w.x, w.z) + BOAT_Y, w.z);
      this.dummy.rotation.y = -w.heading;
      this.dummy.updateMatrix();
      this.mesh!.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh!.instanceMatrix.needsUpdate = true;
  }
}

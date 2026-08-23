/**
 * Shared mesh container and builder used by every world geometry builder
 * (buildings, roads). Pure: no DOM/WebGL — safe to unit-test in node.
 * PM-owned (docs/architecture.md §4.1).
 */
import * as THREE from 'three';

export type Vec3 = [number, number, number];
export type UV = [number, number];

export interface MeshGroup {
  start: number;
  count: number;
  materialIndex: number;
}

/** Non-indexed triangle soup with per-vertex normal, uv and linear colour. */
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  groups: MeshGroup[];
}

/** Accumulates triangles; call `endGroup` to close a material group. */
export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private groups: MeshGroup[] = [];
  private groupStart = 0;

  /** Number of vertices pushed so far. */
  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Push one vertex. `color` is linear rgb in [0, 1]. */
  vertex(p: Vec3, n: Vec3, uv: UV, color: Vec3): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.uv.push(uv[0], uv[1]);
    this.col.push(color[0], color[1], color[2]);
  }

  /** Triangle a→b→c sharing one normal and colour. */
  triangle(a: Vec3, b: Vec3, c: Vec3, n: Vec3, uvA: UV, uvB: UV, uvC: UV, color: Vec3): void {
    this.vertex(a, n, uvA, color);
    this.vertex(b, n, uvB, color);
    this.vertex(c, n, uvC, color);
  }

  /** Quad a→b→c→d (two triangles: a,b,c and a,c,d) sharing normal and colour. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3, uvA: UV, uvB: UV, uvC: UV, uvD: UV, color: Vec3): void {
    this.triangle(a, b, c, n, uvA, uvB, uvC, color);
    this.triangle(a, c, d, n, uvA, uvC, uvD, color);
  }

  /** Close the group started after the previous `endGroup` (or at 0). */
  endGroup(materialIndex: number): void {
    const count = this.vertexCount - this.groupStart;
    if (count > 0) this.groups.push({ start: this.groupStart, count, materialIndex });
    this.groupStart = this.vertexCount;
  }

  /** Freeze into typed arrays. An unclosed trailing group is closed as material 0. */
  build(): MeshData {
    if (this.vertexCount > this.groupStart) this.endGroup(0);
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nor),
      uvs: Float32Array.from(this.uv),
      colors: Float32Array.from(this.col),
      groups: this.groups.slice(),
    };
  }
}

/** Wrap `MeshData` in a three.js geometry (attributes + material groups + bounding sphere). */
export function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
  for (const grp of m.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  g.computeBoundingSphere();
  return g;
}

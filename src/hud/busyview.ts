/**
 * Background-loading indicator — DOM part (T-0171, docs/hud-busy.md).
 * A `#busy` line at the left end of the `#credits` bar, styled in
 * `style.css`. Spans: head (spinner + verb), bar, label — the label span is
 * hidden by CSS below 600 px. Since T-0174 it adopts the static
 * `<div id="busy" class="on boot">` from `index.html` (visible from the first
 * paint) and shows the boot phases via `boot()` until the first `update()`.
 */
import type { LoadProgress } from '../ui/loading';
import {
  BusyGate,
  bootParts,
  busyBar,
  busyLabel,
  busySpinner,
  busyVerb,
  type BusyInputs,
} from './busy';

/** The `#busy` status line: gates, animates and fades the loader text. */
export class BusyView {
  private readonly el: HTMLDivElement;
  private readonly headEl: HTMLSpanElement;
  private readonly barEl: HTMLSpanElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly gate = new BusyGate();
  private inputs: BusyInputs | null = null;
  private label = '';
  private verb = 'SYNC';
  private on = false;
  private neon = false;
  private booting: boolean;

  /**
   * Adopt the static boot `#busy` from `index.html` when present (boot mode),
   * else create a hidden one inside `parent`.
   */
  constructor(parent: HTMLElement) {
    const found = document.getElementById('busy');
    const el = found instanceof HTMLDivElement ? found : document.createElement('div');
    this.el = el;
    this.el.id = 'busy';
    this.el.setAttribute('aria-hidden', 'true');
    this.headEl = adoptSpan(el, 'busy-head');
    this.barEl = adoptSpan(el, 'busy-bar');
    this.labelEl = adoptSpan(el, 'busy-label');
    this.el.replaceChildren(this.headEl, this.barEl, this.labelEl);
    this.booting = this.el.classList.contains('boot');
    this.on = this.el.classList.contains('on');
    if (!found) parent.append(this.el);
  }

  /**
   * Boot-phase frame (T-0174): the lore line for `p` (`null` = no progress
   * yet), shown regardless of the HUD setting unless `visible` is false
   * (city picker waiting). Ignored once `update()` has taken over.
   */
  boot(p: LoadProgress | null, cityLabel: string, tMs: number, neon: boolean, visible: boolean): void {
    if (!this.booting) {
      this.booting = true;
      this.el.classList.add('boot');
    }
    const parts = bootParts(p, cityLabel, tMs);
    this.setNeon(neon);
    const show = visible && parts !== null;
    if (show !== this.on) {
      this.on = show;
      this.el.classList.toggle('on', show);
    }
    if (!show || parts === null) return;
    this.verb = parts.verb;
    this.label = parts.label;
    setText(this.headEl, `${busySpinner(tMs)} ${this.verb} `);
    setText(this.barEl, parts.bar);
    setText(this.labelEl, ` ${this.label}`);
  }

  /**
   * Per-frame update. `inputs` is the fresh poll, or `null` between polls
   * (the last poll is kept). `visible` false (overlay up / HUD off) hides at once.
   */
  update(inputs: BusyInputs | null, tMs: number, neon: boolean, visible: boolean): void {
    if (inputs) this.inputs = inputs;
    if (this.booting) {
      // Boot → background handover: drop `.boot`; a line already up counts as
      // shown, so idle now means the usual 600 ms hold + fade.
      this.booting = false;
      this.el.classList.remove('boot');
      if (this.on) this.gate.force(tMs);
    }
    const label = this.inputs ? busyLabel(this.inputs) : '';
    const show = this.gate.step(label !== '', tMs) && visible;
    this.setNeon(neon);
    if (show !== this.on) {
      this.on = show;
      this.el.classList.toggle('on', show);
    }
    if (!show) return;
    // While idle inside the hold window keep the last non-empty label/verb.
    if (label !== '' && this.inputs) {
      this.label = label;
      this.verb = busyVerb(this.inputs);
    }
    setText(this.headEl, `${busySpinner(tMs)} ${this.verb} `);
    setText(this.barEl, busyBar(tMs));
    setText(this.labelEl, ` ${this.label}`);
  }

  /** Toggle the cyberpunk `.neon` class when it changes. */
  private setNeon(neon: boolean): void {
    if (neon !== this.neon) {
      this.neon = neon;
      this.el.classList.toggle('neon', neon);
    }
  }

  /** Remove the element. */
  dispose(): void {
    this.el.remove();
  }
}

/** The existing `span.<cls>` child of `el`, or a new one. */
function adoptSpan(el: HTMLElement, cls: string): HTMLSpanElement {
  const found = el.querySelector(`:scope > span.${cls}`);
  if (found instanceof HTMLSpanElement) return found;
  const span = document.createElement('span');
  span.className = cls;
  return span;
}

/** Write `text` only when it differs, so unchanged frames touch no DOM. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

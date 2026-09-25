/**
 * Background-loading indicator — DOM part (T-0171, docs/hud-busy.md).
 * A `#busy` line at the left end of the `#credits` bar, styled in
 * `style.css`. Spans: head (spinner + verb), bar, label — the label span is
 * hidden by CSS below 600 px.
 */
import { BusyGate, busyBar, busyLabel, busySpinner, busyVerb, type BusyInputs } from './busy';

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

  /** Create the (hidden) `#busy` element inside `parent`. */
  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'busy';
    this.el.setAttribute('aria-hidden', 'true');
    this.headEl = document.createElement('span');
    this.headEl.className = 'busy-head';
    this.barEl = document.createElement('span');
    this.barEl.className = 'busy-bar';
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'busy-label';
    this.el.append(this.headEl, this.barEl, this.labelEl);
    parent.append(this.el);
  }

  /**
   * Per-frame update. `inputs` is the fresh poll, or `null` between polls
   * (the last poll is kept). `visible` false (overlay up / HUD off) hides at once.
   */
  update(inputs: BusyInputs | null, tMs: number, neon: boolean, visible: boolean): void {
    if (inputs) this.inputs = inputs;
    const label = this.inputs ? busyLabel(this.inputs) : '';
    const show = this.gate.step(label !== '', tMs) && visible;
    if (neon !== this.neon) {
      this.neon = neon;
      this.el.classList.toggle('neon', neon);
    }
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

  /** Remove the element. */
  dispose(): void {
    this.el.remove();
  }
}

/** Write `text` only when it differs, so unchanged frames touch no DOM. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

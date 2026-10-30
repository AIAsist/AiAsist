// Tiny Web Audio synth: no sound files to download.

export class Sound {
  private ctx: AudioContext | null = null;
  muted = false;

  /** Must be called from a user gesture (browsers block audio before that). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      this.ctx = null;
    }
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.15): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  click(): void {
    this.tone(880, 0, 0.06, 'square', 0.05);
  }

  accept(): void {
    this.tone(523, 0, 0.12, 'triangle');
    this.tone(784, 0.09, 0.16, 'triangle');
  }

  pickup(): void {
    this.tone(659, 0, 0.12, 'triangle');
    this.tone(988, 0.1, 0.2, 'triangle');
  }

  deliver(): void {
    [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, i * 0.08, 0.22, 'square', 0.07));
  }

  fail(): void {
    this.tone(196, 0, 0.3, 'sawtooth', 0.08);
    this.tone(147, 0.2, 0.35, 'sawtooth', 0.08);
  }

  /** Bicycle bell: two quick bright dings. */
  bell(): void {
    this.tone(2093, 0, 0.25, 'sine', 0.12);
    this.tone(2093, 0.12, 0.3, 'sine', 0.1);
  }

  dash(): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.25);
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  thud(): void {
    this.tone(90, 0, 0.25, 'square', 0.12);
    this.tone(60, 0.05, 0.3, 'sine', 0.15);
  }

  /** Police whistle: two sharp trills. */
  whistle(): void {
    for (let i = 0; i < 6; i++) this.tone(i % 2 ? 2600 : 2900, i * 0.05, 0.06, 'square', 0.05);
    for (let i = 0; i < 6; i++) this.tone(i % 2 ? 2600 : 2900, 0.4 + i * 0.05, 0.06, 'square', 0.05);
  }

  coin(): void {
    this.tone(1319, 0, 0.1, 'square', 0.06);
    this.tone(1760, 0.07, 0.18, 'square', 0.06);
  }

  private sirenNodes: { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode } | null = null;

  /** Police car siren while a car chases (idempotent). */
  siren(on: boolean): void {
    const ctx = this.ctx;
    if (on && !this.muted && ctx && !this.sirenNodes) {
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 750;
      lfo.frequency.value = 1.6;
      lfoGain.gain.value = 180;
      lfo.connect(lfoGain).connect(osc.frequency);
      gain.gain.value = 0.025;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      lfo.start();
      this.sirenNodes = { osc, lfo, gain };
    } else if ((!on || this.muted) && this.sirenNodes && ctx) {
      const { osc, lfo, gain } = this.sirenNodes;
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      osc.stop(ctx.currentTime + 0.5);
      lfo.stop(ctx.currentTime + 0.5);
      this.sirenNodes = null;
    }
  }
}

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
}

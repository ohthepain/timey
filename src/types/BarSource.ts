export interface BarSource {
  kick: string;
  hihat: string;
  snare: string;
  accent: string;
}

export class BeatSource {
  bars: BarSource[] = [];

  constructor(bars: BarSource[] = []) {
    this.bars = bars;
  }
}

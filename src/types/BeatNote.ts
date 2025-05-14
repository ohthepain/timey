import { GeneralMidiService } from '~/lib/GeneralMidiService';

const hihats = [42, 46, 51, 53, 59];
const kicks = [36, 35];
const snares = [37, 38, 39, 40];

export class BeatNote {
  id: string;
  index: number;
  noteString: string;
  barNum: number;
  beatNum: number;
  divisionNum: number;
  subDivisionNum: number;
  numSubDivisions: number;
  velocity: number;
  duration: number;
  microtiming: number;

  constructor(data: any) {
    this.id = data.id;
    this.index = data.index;
    this.noteString = data.noteString;
    this.barNum = data.barNum;
    this.beatNum = data.beatNum;
    this.divisionNum = data.divisionNum;
    this.subDivisionNum = data.subDivisionNum;
    this.numSubDivisions = data.numSubDivisions;
    this.velocity = data.velocity;
    this.microtiming = data.microtiming;
    this.duration = data.duration;
  }

  toJSON() {
    return {
      id: this.id,
      index: this.index,
      noteString: this.noteString,
      barNum: this.barNum,
      beatNum: this.beatNum,
      divisionNum: this.divisionNum,
      subDivisionNum: this.subDivisionNum,
      numSubDivisions: this.numSubDivisions,
      velocity: this.velocity,
      microtiming: this.microtiming,
      duration: this.duration,
    };
  }

  getPositionMsec(bpm: number): number {
    const beatsPerBar = 4;
    const divisionsPerBeat = 2; // 8th notes
    const beatDurationMsec = 60000 / bpm;
    const divisionDurationMsec = beatDurationMsec / divisionsPerBeat;

    const barTime = this.barNum * beatsPerBar * beatDurationMsec;
    const beatTime = this.beatNum * beatDurationMsec;
    const divisionTime = this.divisionNum * divisionDurationMsec;

    let subDivisionTime = 0;
    if (this.numSubDivisions > 1) {
      const subDivisionDurationMsec = divisionDurationMsec / this.numSubDivisions;
      subDivisionTime = this.subDivisionNum * subDivisionDurationMsec;
    }

    return barTime + beatTime + divisionTime + subDivisionTime + (this.microtiming || 0);
  }

  matchMidiNote(midiNote: number): string | null {
    const drumName = GeneralMidiService.getDrumName(midiNote);
    if (!drumName) {
      throw new Error(`Unknown MIDI note: ${midiNote}`);
    }

    const notes = this.noteString.split(', ');
    if (notes.some((note) => note === drumName)) {
      return drumName;
    }

    for (const note of notes) {
      if (note === 'hihat') {
        // If midiNote is in list then return true
        if (hihats.includes(midiNote)) {
          return 'hihat';
        }
        if (kicks.includes(midiNote)) {
          return 'kick';
        }
        if (snares.includes(midiNote)) {
          return 'snare';
        }
      }
    }

    return null;
  }
}

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
}

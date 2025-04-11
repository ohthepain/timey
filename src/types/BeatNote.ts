export interface BeatNote {
  id: string;
  index: number;
  duration: number;
  noteString: string;
  barNum: number;
  beatNum: number;
  divisionNum: number;
  subDivisionNum: number;
  numSubDivisions: number;
  velocity: number;
}

import { tempoService } from './MidiSync/TempoService';
import { BeatNote } from '~/types/BeatNote';
import { BeatNoteFeedback } from './PerformanceFeedback';
import { GeneralMidiService } from './GeneralMidiService';

type EventType = 'midi' | 'played' | 'missed' | 'extra' | 'timing';

interface EventRecord {
  timestamp: number;
  type: EventType;
  toString(): string;
  toCsv(): string;
}

class MidiNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'midi';
  private note: number;
  private velocity: number;

  constructor(note: number, velocity: number) {
    this.timestamp = tempoService.time;
    this.note = note;
    this.velocity = velocity;
  }

  toString(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `[${this.timestamp}ms] MIDI note ${drumName} (velocity: ${this.velocity})`;
  }

  toCsv(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `${this.timestamp},midi,${drumName},,${this.velocity}`;
  }
}

class PlayedNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'played';
  private note: number;
  private noteString: string;
  private diffMs: number;
  private velocity: number;
  private velocityDiff: number;

  constructor(note: BeatNote, feedback: BeatNoteFeedback) {
    this.timestamp = tempoService.time;
    this.note = Number(note.noteString);
    this.noteString = note.noteString;
    this.diffMs = feedback.timingDifferenceMs || 0;
    this.velocity = note.velocity;
    this.velocityDiff = feedback.velocityDifference || 0;
  }

  toString(): string {
    return `[${this.timestamp}ms] Played ${this.noteString} (timing: ${this.diffMs}ms, velocity: ${this.velocity}, diff: ${this.velocityDiff})`;
  }

  toCsv(): string {
    return `${this.timestamp},played,${this.note},${this.diffMs},${this.velocity}`;
  }
}

class MissedNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'missed';
  private noteString: string;

  constructor(feedback: BeatNoteFeedback) {
    this.timestamp = tempoService.time;
    this.noteString = feedback.missedNotes?.join(' ') || '';
  }

  toString(): string {
    return `[${this.timestamp}ms] Missed ${this.noteString}`;
  }

  toCsv(): string {
    return `${this.timestamp},missed,${this.noteString},,`;
  }
}

class ExtraNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'extra';
  private note: number;
  private noteString: string;

  constructor(note: BeatNote) {
    this.timestamp = tempoService.time;
    this.note = Number(note.noteString);
    this.noteString = note.noteString;
  }

  toString(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `[${this.timestamp}ms] Extra ${drumName}`;
  }

  toCsv(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `${this.timestamp},extra,${drumName},,`;
  }
}

class TimingPulseRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'timing';
  private elapsedMsec: number;

  constructor() {
    this.timestamp = tempoService.time;
    this.elapsedMsec = tempoService.elapsedMsec;
  }

  toString(): string {
    return `[${this.timestamp}ms] Timing pulse (elapsed: ${this.elapsedMsec}ms)`;
  }

  toCsv(): string {
    return `${this.timestamp},timing,,${this.elapsedMsec},`;
  }
}

class EventRecorderService {
  private static _instance: EventRecorderService;
  private events: EventRecord[] = [];

  private constructor() {}

  static getInstance(): EventRecorderService {
    if (!EventRecorderService._instance) {
      EventRecorderService._instance = new EventRecorderService();
    }
    return EventRecorderService._instance;
  }

  recordMidiNote(note: number, velocity: number) {
    this.events.push(new MidiNoteRecord(note, velocity));
  }

  recordNoteFeedback(note: BeatNote, feedback: BeatNoteFeedback) {
    this.events.push(new PlayedNoteRecord(note, feedback));
  }

  recordExtraNote(note: BeatNote) {
    this.events.push(new ExtraNoteRecord(note));
  }

  recordMissedNotes(feedback: BeatNoteFeedback) {
    this.events.push(new MissedNoteRecord(feedback));
  }

  recordTimingPulse() {
    this.events.push(new TimingPulseRecord());
  }

  getEvents(): EventRecord[] {
    return this.events;
  }

  clear() {
    this.events = [];
  }

  toString(): string {
    return this.events.map((e) => e.toString()).join('\n');
  }

  toCsv(): string {
    const header = 'timestamp,type,note,timing,velocity';
    const rows = this.events.map((e) => e.toCsv());
    return [header, ...rows].join('\n');
  }

  saveToCsv(filename: string) {
    const fs = require('fs');
    const path = require('path');
    const csv = this.toCsv();

    // Save previous version if file exists
    if (fs.existsSync(filename)) {
      const prevContent = fs.readFileSync(filename, 'utf8');
      if (prevContent !== csv) {
        console.log(`Changes detected in ${filename}`);
        const { dir, name, ext } = path.parse(filename);
        const prevFile = path.join(dir, `${name}-prev${ext}`);
        fs.writeFileSync(prevFile, prevContent);
      }
    }

    fs.writeFileSync(filename, csv);
  }
}

export const eventRecorder = EventRecorderService.getInstance();

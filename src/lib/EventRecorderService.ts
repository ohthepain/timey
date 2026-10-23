import type { BeatNoteFeedback } from './PerformanceFeedback';
import { GeneralMidiService } from './GeneralMidiService';
import { EventList } from './EventList';
import type { EventRecord, EventType, ReplayTarget } from './EventList';

export type EventPosition = { noteIndex: number; timestamp: number };

class TimingPulseRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'timing';
  private intervalMsec: number;
  private noteIndex: number;

  constructor(intervalMsec: number, noteIndex: number, timestamp: number) {
    if (!intervalMsec || typeof intervalMsec !== 'number' || intervalMsec <= 0) {
      throw new Error('Interval must be a number greater than 0');
    }
    this.timestamp = timestamp;
    this.noteIndex = noteIndex;
    this.intervalMsec = intervalMsec;
  }

  toCsv(): string {
    return `${this.timestamp},${this.noteIndex},timing,,${this.intervalMsec},`;
  }

  replay(target: ReplayTarget): void {
    target.advanceTime(this.intervalMsec);
  }
}

class MidiNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'midi';
  private note: number;
  private velocity: number;
  private noteIndex: number;

  constructor(note: number, velocity: number, noteIndex: number, timestamp: number) {
    this.timestamp = timestamp;
    this.note = note;
    this.velocity = velocity;
    this.noteIndex = noteIndex;
  }

  toCsv(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `${this.timestamp},${this.noteIndex},midi,${drumName},,${this.velocity}`;
  }

  replay(target: ReplayTarget): void {
    target.emitMidiNote(this.note, this.velocity);
  }
}

class PlayedNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'played';
  private note: number;
  private diffMs: number;
  private velocityDiff: number;
  private noteIndex: number;

  constructor(note: number, timeDiffMs: number, velocityDiff: number, noteIndex: number, timestamp: number) {
    this.note = note;
    this.diffMs = timeDiffMs;
    this.velocityDiff = velocityDiff;
    this.noteIndex = noteIndex;
    this.timestamp = timestamp;
  }

  toCsv(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `${this.timestamp},${this.noteIndex},played,${drumName},${this.diffMs},${this.velocityDiff}`;
  }

  replay(): void {}
}

class MissedNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'missed';
  private noteNum: number;
  private noteIndex: number;

  constructor(noteNum: number, noteIndex: number, timestamp: number) {
    this.noteNum = noteNum;
    this.noteIndex = noteIndex;
    this.timestamp = timestamp;
  }

  toCsv(): string {
    return `${this.timestamp},${this.noteIndex},missed,${GeneralMidiService.getDrumName(this.noteNum)},,`;
  }

  replay(): void {}
}

class ExtraNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'extra';
  private note: number;
  private noteIndex: number;

  constructor(note: number, noteIndex: number, timestamp: number) {
    this.note = note;
    this.noteIndex = noteIndex;
    this.timestamp = timestamp;
  }

  toCsv(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `${this.timestamp},${this.noteIndex},extra,${drumName},,`;
  }

  replay(): void {}
}

export class EventRecorderService {
  private static _instance: EventRecorderService | null = null;
  static getInstance(): EventRecorderService {
    if (!EventRecorderService._instance) {
      EventRecorderService._instance = new EventRecorderService();
    }
    return EventRecorderService._instance;
  }
  private events: EventList = new EventList();

  private constructor() {}

  public static shutdown() {
    if (EventRecorderService._instance) {
      EventRecorderService._instance.destroy();
      EventRecorderService._instance = null;
    }
  }

  destroy() {
    this.events.clear();
  }

  recordTimingPulse(intervalMsec: number, position: EventPosition) {
    this.events.addEvent(new TimingPulseRecord(intervalMsec, position.noteIndex, position.timestamp));
  }

  recordMidiNote(note: number, velocity: number, position: EventPosition) {
    this.events.addEvent(new MidiNoteRecord(note, velocity, position.noteIndex, position.timestamp));
  }

  recordNoteFeedback(note: number, timeDiffMs: number, velocityDiff: number, position: EventPosition) {
    this.events.addEvent(new PlayedNoteRecord(note, timeDiffMs, velocityDiff, position.noteIndex, position.timestamp));
  }

  recordExtraNote(note: number, position: EventPosition) {
    this.events.addEvent(new ExtraNoteRecord(note, position.noteIndex, position.timestamp));
  }

  recordMissedNotes(feedback: BeatNoteFeedback, position: EventPosition) {
    if (!feedback.missedNotes || feedback.missedNotes.length === 0) {
      throw new Error('recordMissedNotes: no notes provided');
    }
    for (const notestring of feedback.missedNotes) {
      const noteNum = GeneralMidiService.getNoteNumber(notestring);
      this.events.addEvent(new MissedNoteRecord(noteNum!, position.noteIndex, position.timestamp));
    }
  }

  clear() {
    this.events.clear();
  }

  toCsv(): string {
    return this.events.toCsv();
  }

  replay(target: ReplayTarget): void {
    const playbackEvents = new EventList(this.events);
    this.events.clear();
    for (const event of playbackEvents.getEvents()) {
      event.replay(target);
    }
  }

  saveToCsvServer(filename: string) {
    const fs = require('fs');
    const path = require('path');
    const csv = this.toCsv();

    // Save previous version if file exists
    if (fs.existsSync(filename)) {
      const prevContent = fs.readFileSync(filename, 'utf8');
      if (prevContent != csv) {
        console.log(`Changes detected in ${filename}`);
      }
      const { dir, name, ext } = path.parse(filename);
      const prevFile = path.join(dir, `${name}-prev${ext}`);
      fs.writeFileSync(prevFile, prevContent);
    }

    fs.writeFileSync(filename, csv);
  }

  saveToCsvBrowser(filename: string) {
    const downloadStringAsFile = (content: string, filename: string, mimeType = 'text/plain') => {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = filename; // Suggested filename
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      URL.revokeObjectURL(url); // Clean up
    };
    // Download the csv
    const csv = this.toCsv();
    downloadStringAsFile(csv, filename);
  }

  saveToCsv(filename: string, forceServer = false) {
    if (typeof window === 'undefined' || forceServer) {
      this.saveToCsvServer(filename);
    } else {
      this.saveToCsvBrowser(filename);
    }
  }

  loadFromCsvFile(filename: string) {
    const fs = require('fs');
    const csv = fs.readFileSync(filename, 'utf8');
    this.loadFromCsvText(csv);
  }

  loadFromCsvText(csv: string) {
    this.events.clear();
    const lines = csv.split('\n');
    for (const line of lines) {
      // ignore lines that don't begin with a number
      if (!line.match(/^\d/)) {
        continue;
      }

      // split the line into an array of strings and convert the first element to a number
      let [timestamp_s, noteIndex_s, type, noteString, timing_s, velocity_s] = line.split(',');
      const timestamp = parseFloat(timestamp_s);
      const noteIndex = parseInt(noteIndex_s);
      const noteNum: number = GeneralMidiService.getNoteNumber(noteString)!;
      const timing = parseFloat(timing_s);
      const velocity = parseInt(velocity_s);
      let event: EventRecord | undefined = undefined;
      switch (type) {
        case 'timing':
          event = new TimingPulseRecord(timing, noteIndex, timestamp);
          break;
        case 'midi':
          event = new MidiNoteRecord(noteNum, velocity, noteIndex, timestamp);
          break;
        case 'played':
          event = new PlayedNoteRecord(noteNum, timing, velocity as number, noteIndex, timestamp);
          break;
        case 'missed':
          event = new MissedNoteRecord(noteNum, noteIndex, timestamp);
          break;
        case 'extra':
          event = new ExtraNoteRecord(noteNum, noteIndex, timestamp);
          break;
        default:
          event = undefined;
      }
      if (event) {
        this.events.addEvent(event);
      }
    }
  }
}

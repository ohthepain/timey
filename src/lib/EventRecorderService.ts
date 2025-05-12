import { TempoService } from './TempoService';
import { BeatNote } from '~/types/BeatNote';
import { BeatNoteFeedback } from './PerformanceFeedback';
import { GeneralMidiService } from './GeneralMidiService';
import { BeatRecorder } from './BeatRecorder';
import { EventRecord, EventType, EventList } from './EventList';
import { midiService } from './MidiService';

class MidiNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'midi';
  private note: number;
  private velocity: number;
  private noteIndex: number;

  constructor(note: number, velocity: number) {
    this.timestamp = TempoService.getInstance().elapsedMsec;
    this.note = note;
    this.velocity = velocity;
    this.noteIndex = BeatRecorder.getInstance().getCurrentNoteIndex();
  }

  get tempoService(): TempoService {
    return TempoService.getInstance();
  }

  toString(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `[${this.timestamp}ms] MIDI note ${drumName} (velocity: ${this.velocity})`;
  }

  toCsv(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `${this.timestamp},${this.noteIndex},midi,${drumName},,${this.velocity}`;
  }

  replay(): void {
    midiService.emitMidiNote(this.note, this.velocity);
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
  private noteIndex: number;

  constructor(note: BeatNote, feedback: BeatNoteFeedback) {
    this.timestamp = TempoService.getInstance().elapsedMsec;
    this.note = Number(note.noteString);
    this.noteString = note.noteString;
    this.diffMs = feedback.timingDifferenceMs || 0;
    this.velocity = note.velocity;
    this.velocityDiff = feedback.velocityDifference || 0;
    this.noteIndex = BeatRecorder.getInstance().getCurrentNoteIndex();
  }

  toString(): string {
    return `[${this.timestamp}ms] Played ${this.noteString} (timing: ${this.diffMs}ms, velocity: ${this.velocity}, diff: ${this.velocityDiff})`;
  }

  toCsv(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `${this.timestamp},${this.noteIndex},played,${drumName},${this.diffMs},${this.velocity}`;
  }

  replay(): void {}
}

class MissedNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'missed';
  private noteString: string;
  private noteIndex: number;

  constructor(feedback: BeatNoteFeedback) {
    this.timestamp = TempoService.getInstance().elapsedMsec;
    this.noteString = feedback.missedNotes?.join(' ') || '';
    this.noteIndex = BeatRecorder.getInstance().getCurrentNoteIndex();
  }

  toString(): string {
    return `[${this.timestamp}ms] Missed ${this.noteString}`;
  }

  toCsv(): string {
    return `${this.timestamp},${this.noteIndex},missed,${this.noteString},,`;
  }

  replay(): void {}
}

class ExtraNoteRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'extra';
  private note: number;
  private noteString: string;
  private noteIndex: number;

  constructor(note: BeatNote) {
    this.timestamp = TempoService.getInstance().elapsedMsec;
    this.note = Number(note.noteString);
    this.noteString = note.noteString;
    this.noteIndex = BeatRecorder.getInstance().getCurrentNoteIndex();
  }

  toString(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `[${this.timestamp}ms] Extra ${drumName}`;
  }

  toCsv(): string {
    const drumName = GeneralMidiService.getDrumName(this.note) || `note ${this.note}`;
    return `${this.timestamp},${this.noteIndex},extra,${drumName},,`;
  }

  replay(): void {}
}

class TimingPulseRecord implements EventRecord {
  timestamp: number;
  type: EventType = 'timing';
  private intervalMsec: number;
  private noteIndex: number;

  constructor(intervalMsec: number) {
    if (intervalMsec <= 0) {
      throw new Error('Interval must be greater than 0');
    }
    this.timestamp = TempoService.getInstance().elapsedMsec;
    this.intervalMsec = intervalMsec;
    this.noteIndex = BeatRecorder.getInstance().getCurrentNoteIndex();
  }

  toString(): string {
    return `[${this.timestamp}ms] Timing pulse (elapsed: ${this.intervalMsec}ms)`;
  }

  toCsv(): string {
    return `${this.timestamp},${this.noteIndex},timing,,${this.intervalMsec},`;
  }

  replay(): void {
    TempoService.getInstance().simulateInterval(this.intervalMsec);
  }
}

export class EventRecorderService {
  private static _instance: EventRecorderService;
  static getInstance(): EventRecorderService {
    if (!EventRecorderService._instance) {
      EventRecorderService._instance = new EventRecorderService();
    }
    return EventRecorderService._instance;
  }
  private events: EventList = new EventList();

  private constructor() {}

  get tempoService(): TempoService {
    return TempoService.getInstance();
  }

  recordMidiNote(note: number, velocity: number) {
    this.events.addEvent(new MidiNoteRecord(note, velocity));
  }

  recordNoteFeedback(note: BeatNote, feedback: BeatNoteFeedback) {
    this.events.addEvent(new PlayedNoteRecord(note, feedback));
  }

  recordExtraNote(note: BeatNote) {
    this.events.addEvent(new ExtraNoteRecord(note));
  }

  recordMissedNotes(feedback: BeatNoteFeedback) {
    this.events.addEvent(new MissedNoteRecord(feedback));
  }

  recordTimingPulse(intervalMsec: number) {
    this.events.addEvent(new TimingPulseRecord(intervalMsec));
  }

  getEvents(): EventRecord[] {
    return this.events.getEvents();
  }

  clear() {
    this.events.clear();
  }

  toString(): string {
    return this.events.toString();
  }

  toCsv(): string {
    return this.events.toCsv();
  }

  replay(): void {
    const wasRecording = this.tempoService.isRecording;

    BeatRecorder.getInstance().setBeat(BeatRecorder.getInstance().beat!);
    this.tempoService.prepareIntervalTimer();

    this.tempoService.reset();
    this.tempoService.startSimulatedIntervalTimerForTesting();
    if (wasRecording) {
      this.tempoService.record();
    }

    const playbackEvents = new EventList(this.events);
    this.events.clear();
    for (const event of playbackEvents.getEvents()) {
      event.replay();
    }
  }

  saveToCsv(filename: string) {
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
}

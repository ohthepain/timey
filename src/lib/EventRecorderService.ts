import { TempoService } from './TempoService';
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

  constructor(note: number, velocity: number, noteIndex: number, timestamp: number) {
    this.timestamp = timestamp;
    this.note = note;
    this.velocity = velocity;
    this.noteIndex = noteIndex;
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
  private velocityDiff: number;
  private noteIndex: number;

  constructor(note: number, timeDiffMs: number, velocityDiff: number, noteIndex: number, timestamp: number) {
    this.note = note;
    this.noteString = GeneralMidiService.getDrumName(note)!;
    this.diffMs = timeDiffMs;
    this.velocityDiff = velocityDiff;
    this.noteIndex = noteIndex;
    this.timestamp = timestamp;
  }

  toString(): string {
    return `[${this.timestamp}ms] Played ${this.noteString} (timing: ${this.diffMs}ms, velocity: ${this.velocityDiff}, diff: ${this.velocityDiff})`;
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

  toString(): string {
    return `[${this.timestamp}ms] Missed ${GeneralMidiService.getDrumName(this.noteNum)}`;
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

  constructor(intervalMsec: number, noteIndex: number, timestamp: number) {
    if (!intervalMsec || typeof intervalMsec !== 'number' || intervalMsec <= 0) {
      throw new Error('Interval must be a number greater than 0');
    }
    this.timestamp = timestamp;
    this.noteIndex = noteIndex;
    this.intervalMsec = intervalMsec;
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
    this.events.addEvent(
      new MidiNoteRecord(
        note,
        velocity,
        BeatRecorder.getInstance().getCurrentNoteIndex(),
        TempoService.getInstance().elapsedMsec
      )
    );
  }

  recordNoteFeedback(note: number, timeDiffMs: number, velocityDiff: number) {
    this.events.addEvent(
      new PlayedNoteRecord(
        note,
        timeDiffMs,
        velocityDiff,
        BeatRecorder.getInstance().getCurrentNoteIndex(),
        TempoService.getInstance().elapsedMsec
      )
    );
  }

  recordExtraNote(note: number) {
    this.events.addEvent(
      new ExtraNoteRecord(
        note,
        BeatRecorder.getInstance().getCurrentNoteIndex(),
        TempoService.getInstance().elapsedMsec
      )
    );
  }

  recordMissedNotes(feedback: BeatNoteFeedback) {
    if (!feedback.missedNotes || feedback.missedNotes.length === 0) {
      throw new Error('recordMissedNotes: no notes provided');
    }
    for (const notestring in feedback.missedNotes) {
      const noteNum = GeneralMidiService.getNoteNumber(notestring);
      this.events.addEvent(
        new MissedNoteRecord(
          noteNum!,
          BeatRecorder.getInstance().getCurrentNoteIndex(),
          TempoService.getInstance().elapsedMsec
        )
      );
    }
  }

  recordTimingPulse(intervalMsec: number) {
    this.events.addEvent(
      new TimingPulseRecord(
        intervalMsec,
        BeatRecorder.getInstance().getCurrentNoteIndex(),
        TempoService.getInstance().elapsedMsec
      )
    );
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

    const beatRecorder = BeatRecorder.getInstance();
    beatRecorder.setBeat(beatRecorder.beat!);
    this.tempoService.prepareIntervalTimer(); // TODO: Why is this here for replay? We don't use the interval timer.

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

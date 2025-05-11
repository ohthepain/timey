export type EventType = 'midi' | 'played' | 'missed' | 'extra' | 'timing';

export interface EventRecord {
  timestamp: number;
  type: EventType;
  toString(): string;
  toCsv(): string;
  replay(): void;
}

export class EventList {
  private events: EventRecord[];

  constructor(eventsOrList?: EventRecord[] | EventList) {
    if (eventsOrList instanceof EventList) {
      this.events = [...eventsOrList.events];
    } else {
      this.events = eventsOrList || [];
    }
  }

  addEvent(event: EventRecord): void {
    this.events.push(event);
  }

  getEvents(): EventRecord[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
  }

  toString(): string {
    return this.events.map((e) => e.toString()).join('\n');
  }

  toCsv(): string {
    const header = 'timestamp,noteIndex,type,note,timing,velocity';
    const rows = this.events.map((e) => e.toCsv());
    return [header, ...rows].join('\n');
  }
}

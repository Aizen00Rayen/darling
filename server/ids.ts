import { randomBytes } from 'node:crypto';
import { systemClock, type Clock } from './clock';

// UUIDv7-style identifiers: 48-bit millisecond timestamp, version 7, a 12-bit counter that keeps ids
// generated in the same millisecond (or after the clock stepped back) strictly increasing, RFC 4122
// variant, then 62 random bits. They sort as plain strings in creation order.
interface State {
  lastTs: number;
  counter: number;
}
const states = new WeakMap<Clock, State>(); // per clock, so a test clock never inherits the real clock's history

export function newId(clock: Clock = systemClock): string {
  let state = states.get(clock);
  if (!state) {
    state = { lastTs: 0, counter: 0 };
    states.set(clock, state);
  }
  const now = Math.trunc(clock.now());
  if (now > state.lastTs) {
    state.lastTs = now;
    state.counter = randomBytes(2).readUInt16BE(0) & 0x1ff; // start low so a burst has room to count up
  } else {
    state.counter += 1;
    if (state.counter > 0xfff) {
      state.lastTs += 1; // more than 4096 ids in one millisecond: borrow the next one
      state.counter = 0;
    }
  }
  const rand = randomBytes(8);
  rand[0] = (rand[0]! & 0x3f) | 0x80; // variant 10xx
  const hex = state.lastTs.toString(16).padStart(12, '0') + '7' + state.counter.toString(16).padStart(3, '0') + rand.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

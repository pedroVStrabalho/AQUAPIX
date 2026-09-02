/**
 * Minimal synchronous event bus. Every match state transition and simulation
 * event flows through here so that the match log (section 41), the HUD, the
 * commentary system and the statistics collector all observe the same stream.
 */
export class EventBus {
  constructor() {
    this._handlers = new Map();
    this._any = [];
  }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(fn);
    return () => this.off(type, fn);
  }

  onAny(fn) {
    this._any.push(fn);
    return () => {
      const i = this._any.indexOf(fn);
      if (i >= 0) this._any.splice(i, 1);
    };
  }

  off(type, fn) {
    const list = this._handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload = {}) {
    const evt = { type, ...payload };
    const list = this._handlers.get(type);
    if (list) for (const fn of list.slice()) fn(evt);
    for (const fn of this._any.slice()) fn(evt);
    return evt;
  }

  clear() {
    this._handlers.clear();
    this._any.length = 0;
  }
}

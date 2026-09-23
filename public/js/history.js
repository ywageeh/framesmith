// Snapshot undo/redo. Documents are small plain objects (images live elsewhere by id),
// so structured clones are cheap and immune to aliasing bugs.

export class History {
  constructor(initial, limit = 100) {
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.present = structuredClone(initial);
  }

  /** Record `next` as the new present. No-op when nothing changed. */
  push(next) {
    if (JSON.stringify(next) === JSON.stringify(this.present)) return false;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = structuredClone(next);
    this.future = [];
    return true;
  }

  undo() {
    if (!this.past.length) return null;
    this.future.push(this.present);
    this.present = this.past.pop();
    return structuredClone(this.present);
  }

  redo() {
    if (!this.future.length) return null;
    this.past.push(this.present);
    this.present = this.future.pop();
    return structuredClone(this.present);
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }
}

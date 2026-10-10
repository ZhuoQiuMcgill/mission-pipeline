// Immutable map snapshots for publishing derived state (6.1: readers only ever
// see a complete revision).
//
// Each published revision is a stack of layers, newest last. Publishing a
// revision adds one layer holding only what changed, so its cost follows the
// change, not the size of the state (5.5). Layers merge like a binary counter:
// while the layer below is at most twice the size of the top one, the two merge
// into a new map. That keeps the stack O(log n) deep and costs O(log n) copies
// per changed entry over time. Merging always builds new maps; a snapshot a
// reader holds never changes.
//
// Immutability is enforced at run time, not only by types (core review r2 F6):
// the layers live in a true private field that no caller can reach, the layer
// maps are never handed out, and every instance is frozen.

const DELETED: unique symbol = Symbol('deleted');
type Slot<V> = V | typeof DELETED;

export class SnapshotMap<K, V> implements ReadonlyMap<K, V> {
  readonly #layers: readonly ReadonlyMap<K, Slot<V>>[];
  readonly #size: number;

  private constructor(layers: readonly ReadonlyMap<K, Slot<V>>[], size: number) {
    this.#layers = Object.freeze([...layers]);
    this.#size = size;
    Object.freeze(this);
  }

  static empty<K, V>(): SnapshotMap<K, V> {
    return new SnapshotMap<K, V>([], 0);
  }

  static of<K, V>(entries: Iterable<readonly [K, V]>): SnapshotMap<K, V> {
    const m = new Map<K, Slot<V>>(entries);
    return new SnapshotMap<K, V>(m.size > 0 ? [m] : [], m.size);
  }

  get size(): number {
    return this.#size;
  }

  /** A new snapshot with `changes` applied: a value sets the key, `undefined` deletes it. */
  with(changes: ReadonlyMap<K, V | undefined>): SnapshotMap<K, V> {
    if (changes.size === 0) return this;
    const delta = new Map<K, Slot<V>>();
    let size = this.#size;
    for (const [k, v] of changes) {
      const had = this.has(k);
      if (v === undefined) {
        if (!had) continue;
        delta.set(k, DELETED);
        size--;
      } else {
        delta.set(k, v);
        if (!had) size++;
      }
    }
    if (delta.size === 0) return this;
    const layers = [...this.#layers, delta];
    while (layers.length >= 2 && layers[layers.length - 2]!.size <= 2 * layers[layers.length - 1]!.size) {
      const top = layers.pop()!;
      const below = layers.pop()!;
      const merged = new Map<K, Slot<V>>(below);
      const intoBase = layers.length === 0;
      for (const [k, v] of top) {
        if (v === DELETED && intoBase) merged.delete(k);
        else merged.set(k, v);
      }
      layers.push(merged);
    }
    return new SnapshotMap<K, V>(layers, size);
  }

  get(key: K): V | undefined {
    const layers = this.#layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!;
      if (layer.has(key)) {
        const v = layer.get(key)!;
        return v === DELETED ? undefined : v;
      }
    }
    return undefined;
  }

  has(key: K): boolean {
    const layers = this.#layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!;
      if (layer.has(key)) return layer.get(key) !== DELETED;
    }
    return false;
  }

  *entries(): MapIterator<[K, V]> {
    const seen = new Set<K>();
    const layers = this.#layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      for (const [k, v] of layers[i]!) {
        if (seen.has(k)) continue;
        seen.add(k);
        if (v !== DELETED) yield [k, v];
      }
    }
  }

  *keys(): MapIterator<K> {
    for (const [k] of this.entries()) yield k;
  }

  *values(): MapIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void): void {
    for (const [k, v] of this.entries()) fn(v, k, this);
  }

  /** Number of layers (for tests of the merge policy). */
  depth(): number {
    return this.#layers.length;
  }
}

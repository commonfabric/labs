/**
 * Minimal typed EventEmitter class.
 *
 * Usage:
 * ```ts
 * type Events = {
 *   data: [string, number];
 *   error: [Error];
 *   close: [];
 * };
 *
 * const emitter = new EventEmitter<Events>();
 * emitter.on('data', (str, num) => { ... });
 * emitter.emit('data', 'hello', 42);
 * ```
 */
export class EventEmitter<Events extends Record<string, unknown[]>> {
  #listeners = new Map<
    keyof Events,
    Set<(...args: unknown[]) => void>
  >();

  on<K extends keyof Events>(
    event: K,
    listener: (...args: Events[K]) => void,
  ): this {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof Events>(
    event: K,
    listener: (...args: Events[K]) => void,
  ): this {
    this.#listeners.get(event)?.delete(
      listener as (...args: unknown[]) => void,
    );
    return this;
  }

  once<K extends keyof Events>(
    event: K,
    listener: (...args: Events[K]) => void,
  ): this {
    const wrapper = (...args: Events[K]) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of set) {
      listener(...args);
    }
    return true;
  }

  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event === undefined) {
      this.#listeners.clear();
    } else {
      this.#listeners.delete(event);
    }
    return this;
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}

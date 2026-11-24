// A small memory of recent results: the same question about the same manual, asked again
// within a few minutes, gets the answer that was already worked out. Bounded in size and in
// time, and kept in this one server instance only.
export class Recent<T> {
  private items = new Map<string, { value: T; at: number }>();
  constructor(private max: number, private ttlMs: number) {}

  get(key: string, now = Date.now()): T | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (now - item.at > this.ttlMs) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.items.delete(key);
    this.items.set(key, { value, at: now });
    // The oldest goes first: a Map keeps the order things were put in.
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value as string);
  }

  get size(): number {
    return this.items.size;
  }
}

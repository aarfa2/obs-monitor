type Bucket = { n: number; resetAt: number };

export class LoginGate {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly max = 8,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  blocked(key: string): boolean {
    return this.bucket(key).n >= this.max;
  }

  fail(key: string): void {
    this.bucket(key).n += 1;
  }

  ok(key: string): void {
    this.buckets.delete(key);
  }

  private bucket(key: string): Bucket {
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || now >= current.resetAt) {
      const next = { n: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, next);
      return next;
    }
    return current;
  }
}

/** A serial writer whose first failure remains visible until its owner reloads. */
export class PersistenceQueue {
  private tail: Promise<void> = Promise.resolve();
  private failure: { error: unknown } | undefined;

  assertHealthy(): void {
    if (this.failure) throw this.failure.error;
  }

  enqueue(write: () => Promise<void>): void {
    this.assertHealthy();
    this.tail = this.tail.then(async () => {
      this.assertHealthy();
      await write();
    }).catch(error => { this.failure ??= { error }; });
  }

  async flush(): Promise<void> {
    await this.tail;
    this.assertHealthy();
  }
}

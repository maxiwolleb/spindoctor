/**
 * Concurrency semaphore: limits the number of concurrent acquisitions.
 * Excess acquire() calls queue FIFO and resolve as slots become available.
 */
export class Semaphore {
  private available: number
  private queue: Array<(value: void) => void> = []

  constructor(max: number) {
    this.available = max
  }

  /**
   * Acquire a slot from the semaphore.
   * Resolves with an idempotent release function.
   */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--
      return this.createRelease()
    }

    // Wait for a slot to become available
    await new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })

    return this.createRelease()
  }

  private createRelease(): () => void {
    let released = false

    return () => {
      if (released) {
        return
      }
      released = true

      const waiter = this.queue.shift()
      if (waiter) {
        waiter()
      } else {
        this.available++
      }
    }
  }
}

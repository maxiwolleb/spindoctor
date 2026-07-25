import { describe, it, expect } from "vitest"
import { Semaphore } from "./semaphore"

describe("Semaphore", () => {
  it("allows up to max concurrent acquisitions", async () => {
    const sem = new Semaphore(2)
    const order: number[] = []

    const p1 = (async () => {
      const release = await sem.acquire()
      order.push(1)
      return release
    })()

    const p2 = (async () => {
      const release = await sem.acquire()
      order.push(2)
      return release
    })()

    const p3 = (async () => {
      const release = await sem.acquire()
      order.push(3)
      return release
    })()

    // Give time for first two to resolve
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual([1, 2])

    // Release one, third should now resolve
    const release1 = await p1
    release1()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual([1, 2, 3])

    // Clean up by releasing the held slots
    const release2 = await p2
    const release3 = await p3

    release2()
    release3()
  })

  it("processes queued acquires in FIFO order", async () => {
    const sem = new Semaphore(1)
    const order: number[] = []

    const release1Holder: { release?: () => void } = {}
    const _p1 = (async () => {
      const release = await sem.acquire()
      order.push(1)
      release1Holder.release = release
      return release
    })()

    const p2 = (async () => {
      const release = await sem.acquire()
      order.push(2)
      return release
    })()

    const p3 = (async () => {
      const release = await sem.acquire()
      order.push(3)
      return release
    })()

    // First should resolve immediately
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual([1])

    // Release the first, second should queue in order
    release1Holder.release?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual([1, 2])

    // Release second, third should resolve
    const release2 = await p2
    release2()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual([1, 2, 3])

    const release3 = await p3
    release3()
  })

  it("handles double-release idempotently", async () => {
    const sem = new Semaphore(1)
    const order: string[] = []

    const release1Holder: { release?: () => void } = {}
    const _p1 = (async () => {
      const release = await sem.acquire()
      order.push("acquired-1")
      release1Holder.release = release
      return release
    })()

    const p2 = (async () => {
      const release = await sem.acquire()
      order.push("acquired-2")
      return release
    })()

    const p3 = (async () => {
      const release = await sem.acquire()
      order.push("acquired-3")
      return release
    })()

    // First resolves immediately
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(["acquired-1"])

    // Release first twice (second is idempotent)
    release1Holder.release?.()
    release1Holder.release?.()

    // Should only allow one to proceed (second), not both
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(["acquired-1", "acquired-2"])

    // Release second
    const release2 = await p2
    release2()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(["acquired-1", "acquired-2", "acquired-3"])

    const release3 = await p3
    release3()
  })
})

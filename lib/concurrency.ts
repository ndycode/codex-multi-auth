/** Bounded independent work, refilling free slots immediately and preserving result order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError("Concurrency must be a positive integer");
    const results: R[] = new Array(items.length);
    let next = 0;
    let failed = false;
    let failure: unknown;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (!failed) {
            const index = next++;
            if (index >= items.length)
                return;
            const item = items[index];
            if (item === undefined)
                continue;
            try {
                results[index] = await worker(item, index);
            }
            catch (error) {
                if (!failed)
                    failure = error;
                failed = true;
            }
        }
    }));
    // Drain active work before returning an error, so no detached writes survive the caller.
    if (failed)
        throw failure;
    return results;
}

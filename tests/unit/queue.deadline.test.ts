import { expect, test } from 'vitest';
import { withQueueDeadline } from '../../src/lib/queue.js';

// The Redis connection buffers commands while the server is down rather than failing
// them, so a command that never settles is the shape every queue call takes during an
// outage: it has to become an answer instead of a hung request.
test('a queue command that never settles is refused rather than left waiting', async () => {
  const started = Date.now();

  await expect(withQueueDeadline(new Promise(() => {}))).rejects.toMatchObject({
    code: 'QUEUE_UNAVAILABLE',
    httpStatus: 503,
  });

  expect(Date.now() - started).toBeLessThan(2000);
});

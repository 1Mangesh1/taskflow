import { expect, test } from 'vitest';
import { toJobStatus } from '../../src/modules/jobs/controller.js';

// A caller polling a job id only cares whether it has started, finished, or failed, so
// every BullMQ way of saying "queued" has to collapse into one of the four statuses.
// The map itself is typed by JobState, so a state a later BullMQ adds fails to compile
// rather than answering undefined.
test('every queued state answers pending, whatever kept the job waiting', () => {
  expect(toJobStatus('waiting')).toBe('pending');
  expect(toJobStatus('delayed')).toBe('pending');
  expect(toJobStatus('prioritized')).toBe('pending');
  expect(toJobStatus('waiting-children')).toBe('pending');
});

test('the running and finished states are reported as themselves', () => {
  expect(toJobStatus('active')).toBe('active');
  expect(toJobStatus('completed')).toBe('completed');
  expect(toJobStatus('failed')).toBe('failed');
});

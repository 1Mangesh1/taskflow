import { expect, test } from 'vitest';
import { paginationQuery } from '../../src/lib/pagination.js';

test('an absent page and limit fall back to the first page of twenty', () => {
  expect(paginationQuery.parse({})).toEqual({ skip: 0, take: 20, page: 1, limit: 20 });
});

// Query values arrive as strings, so the helper has to coerce before it can count.
test('a page is turned into the number of rows before it', () => {
  expect(paginationQuery.parse({ page: '3', limit: '20' })).toEqual({
    skip: 40,
    take: 20,
    page: 3,
    limit: 20,
  });
  expect(paginationQuery.parse({ page: '2', limit: '15' })).toEqual({
    skip: 15,
    take: 15,
    page: 2,
    limit: 15,
  });
  expect(paginationQuery.parse({ limit: '100' })).toEqual({
    skip: 0,
    take: 100,
    page: 1,
    limit: 100,
  });
});

test('a page below one or a limit outside one to a hundred is rejected', () => {
  for (const query of [{ page: '0' }, { page: '-1' }, { page: '1.5' }, { limit: '0' }]) {
    expect(paginationQuery.safeParse(query).success).toBe(false);
  }
  // The upper bound is what keeps a single request from reading the whole table.
  expect(paginationQuery.safeParse({ limit: '101' }).success).toBe(false);
  expect(paginationQuery.safeParse({ limit: '500' }).success).toBe(false);
});

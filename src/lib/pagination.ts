import { z } from 'zod';

// The querystring schema of every paginated list route: it validates the raw query,
// applies the shared defaults and bounds, and hands the service the offset it needs.
// Out-of-range values fail here, so a list route can never be asked for the whole table.
export const paginationQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform(({ page, limit }) => ({ skip: (page - 1) * limit, take: limit, page, limit }));

export type Pagination = z.infer<typeof paginationQuery>;

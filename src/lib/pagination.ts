import { z } from 'zod';

// The querystring fields of every paginated list route: the shared defaults and bounds
// live here, so a list route can never be asked for the whole table. A route that also
// takes filters extends this object rather than restating the bounds.
export const paginationFields = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Turns the validated page into the offset the service needs.
export const toPage = ({ page, limit }: z.infer<typeof paginationFields>) => ({
  skip: (page - 1) * limit,
  take: limit,
  page,
  limit,
});

export const paginationQuery = paginationFields.transform(toPage);

export type Pagination = z.infer<typeof paginationQuery>;

export type Page<T, Cursor> = {
  items: T[];
  nextCursor: Cursor | undefined;
  hasMore: boolean;
};

export type PaginationResult<T, Cursor> = {
  items: T[];
  pages: number;
  scanned: number;
  complete: boolean;
  hasMore: boolean;
  nextCursor: Cursor | null;
  stoppedReason: 'complete' | 'max_pages' | 'max_items' | 'cursor_loop' | 'missing_cursor';
};

export async function collectPages<T, Cursor>(options: {
  fetchPage: (cursor: Cursor | undefined, pageNumber: number) => Promise<Page<T, Cursor>>;
  initialCursor?: Cursor | undefined;
  maxPages?: number | undefined;
  maxItems?: number | undefined;
}): Promise<PaginationResult<T, Cursor>> {
  const maxPages = Math.min(Math.max(Math.trunc(options.maxPages || 50), 1), 500);
  const maxItems = Math.min(Math.max(Math.trunc(options.maxItems || 100_000), 1), 1_000_000);
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor = options.initialCursor;
  let pages = 0;

  while (pages < maxPages && items.length < maxItems) {
    const page = await options.fetchPage(cursor, pages + 1);
    pages += 1;
    const remaining = maxItems - items.length;
    items.push(...page.items.slice(0, remaining));

    if (!page.hasMore) {
      return {
        items,
        pages,
        scanned: items.length,
        complete: true,
        hasMore: false,
        nextCursor: null,
        stoppedReason: 'complete',
      };
    }
    if (items.length >= maxItems) {
      return {
        items,
        pages,
        scanned: items.length,
        complete: false,
        hasMore: true,
        nextCursor: page.nextCursor ?? null,
        stoppedReason: 'max_items',
      };
    }
    if (page.nextCursor === undefined) {
      return {
        items,
        pages,
        scanned: items.length,
        complete: false,
        hasMore: true,
        nextCursor: null,
        stoppedReason: 'missing_cursor',
      };
    }

    const serialized = JSON.stringify(page.nextCursor);
    if (seenCursors.has(serialized)) {
      return {
        items,
        pages,
        scanned: items.length,
        complete: false,
        hasMore: true,
        nextCursor: page.nextCursor,
        stoppedReason: 'cursor_loop',
      };
    }
    seenCursors.add(serialized);
    cursor = page.nextCursor;
  }

  return {
    items,
    pages,
    scanned: items.length,
    complete: false,
    hasMore: true,
    nextCursor: cursor ?? null,
    stoppedReason: pages >= maxPages ? 'max_pages' : 'max_items',
  };
}

export function arrayFromResponse(value: unknown, candidateKeys: string[] = []): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of candidateKeys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

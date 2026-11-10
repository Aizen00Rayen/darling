// Task 5 replaces this with the Drizzle database type.
export type Db = { execute(query: unknown): Promise<unknown> };

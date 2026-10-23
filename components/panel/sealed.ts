import type { SealedLiveQuery } from "@neon/realtime/client";

export type Feed<Row> = {
  initialData: Row[];
  sealedQuery: SealedLiveQuery<Row>;
};

/** Renewals must seal the same query, so each live query keeps its own route. */
export async function fetchSealed<Row>(path: string) {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Could not fetch the sealed query (${res.status})`);
  }
  return (await res.json()) as SealedLiveQuery<Row>;
}

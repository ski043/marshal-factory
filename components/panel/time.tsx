"use client";

import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/** Runs `read` only in the browser, so server HTML never bakes in the server's clock or timezone. */
export function useAfterHydration<T extends string | number>(
  read: () => T,
  fallback: T,
): T {
  return useSyncExternalStore(noSubscription, read, () => fallback);
}

export function Time({ date }: { date: Date }) {
  const text = useAfterHydration(
    () => date.toLocaleTimeString("en-GB", { hour12: false }),
    "",
  );
  return <time dateTime={date.toISOString()}>{text}</time>;
}

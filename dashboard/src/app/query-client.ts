import { matchQuery, MutationCache, QueryClient, type QueryKey } from "@tanstack/react-query";

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      // Query keys (prefix-matched) to invalidate after the mutation succeeds. Without it, every
      // query is invalidated: only active ones refetch, the rest refetch when next used.
      invalidates?: readonly QueryKey[];
    };
  }
}

// https://tkdodo.eu/blog/automatic-query-invalidation-after-mutations
export function createQueryClient() {
  const queryClient: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _context, mutation) => {
        // Not returned: the mutation settles without waiting for refetches. A mutation that must
        // wait returns invalidateQueries(..., { cancelRefetch: false }) from its own onSuccess.
        void queryClient.invalidateQueries({
          predicate: (query) =>
            mutation.meta?.invalidates?.some((queryKey) => matchQuery({ queryKey }, query)) ?? true,
        });
      },
    }),
  });
  return queryClient;
}

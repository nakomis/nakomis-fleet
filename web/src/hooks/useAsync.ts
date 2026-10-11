import { useCallback, useEffect, useRef, useState } from 'react';

/** Runs `load` on mount and whenever `key` changes; `reload` re-runs it. */
export function useAsync<T>(load: () => Promise<T>, key: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: key identifies what is being loaded
  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await loadRef.current());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, setData, error, loading, reload };
}

import { useEffect, useRef, useState } from "react";
import { performAction, useStore } from "./api";

interface BatchResult {
  complete: boolean;
  retry_at: number;
  reason: string;
}

/** Continue bounded server steps only while the initiating page and session remain active. */
export function useBatchRefresh<T extends BatchResult>(
  path: string,
  continuation: (result: T) => Record<string, unknown>,
) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<T | null>(null);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const active = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run(
    input: Record<string, unknown> = {},
  ): Promise<T | null | undefined> {
    const current = useStore.getState();
    if (active.current || current.busy || current.auth !== "authenticated")
      return;
    const session = current.requestVersion;
    active.current = true;
    setRunning(true);
    setNotice("");
    if (!Object.keys(input).length) setProgress(null);
    try {
      for (let step = 0; step < 100; step++) {
        const result = await performAction<T>(path, "POST", input);
        const state = useStore.getState();
        if (state.requestVersion !== session) return;
        if (!mounted.current) {
          useStore.setState({ message: "" });
          return;
        }
        if (!result) return null;
        setProgress(result);
        if (result.complete) return result;
        useStore.setState({ message: "" });
        if (result.retry_at > state.data!.now) return result;
        input = continuation(result);
      }
      setNotice("本次已获取部分数据，可点击继续获取剩余内容。");
      return null;
    } finally {
      active.current = false;
      if (mounted.current) setRunning(false);
    }
  }

  return { run, running, progress, notice };
}

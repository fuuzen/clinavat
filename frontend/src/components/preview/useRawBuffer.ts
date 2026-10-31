import { useEffect, useState } from "react";
import { errorText } from "../../api";
import { fetchRaw } from "./fileKinds";

export type RawState<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; value: T };

// Downloads a workspace file and parses it; re-runs whenever the URL (which carries the file version) changes.
export function useRawBuffer<T>(url: string, parse: (buffer: ArrayBuffer) => Promise<T> | T): RawState<T> {
  const [state, setState] = useState<RawState<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchRaw(url)
      .then(parse)
      .then((value) => !cancelled && setState({ status: "ready", value }))
      .catch((cause) => !cancelled && setState({ status: "error", error: errorText(cause) }));
    return () => {
      cancelled = true;
    };
    // Parsers are module-level functions, so the URL alone identifies the work.
  }, [url]);
  return state;
}

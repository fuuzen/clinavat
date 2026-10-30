import { useEffect, useState } from "react";
import { readBrandStorage } from "./brandStorage";

function readSelection(key: string) {
  try {
    return readBrandStorage(localStorage, key) || "";
  } catch {
    return "";
  }
}

export function useWorkspaceSelection() {
  const [projectId, setProjectId] = useState(() => readSelection("clinavat-project"));
  const [sessionId, setSessionId] = useState(() => readSelection("clinavat-session"));

  useEffect(() => {
    try {
      localStorage.setItem("clinavat-project", projectId);
      localStorage.setItem("clinavat-session", sessionId);
    } catch {
      // Storage restrictions must not prevent navigation or access to in-memory drafts.
    }
  }, [projectId, sessionId]);

  return { projectId, setProjectId, sessionId, setSessionId };
}

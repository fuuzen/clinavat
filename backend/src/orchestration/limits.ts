/** What a master agent may do with its children. Fixed for now; the admin panel does not offer them yet. */
export const orchestrationLimits = {
  /** Children with a task in progress, per master and per user. */
  runningPerMaster: 4,
  runningPerUser: 8,
  /** Children allowed to modify files that may run at once under one master: they share the project directory. */
  writersPerMaster: 1,
  /** Automatic report turns after the user's last message; then reports wait for the user. */
  reportTurnsPerMessage: 20,
  /** A report longer than this is cut; the master can read the rest with read_agent. */
  reportCharacters: 16 * 1024,
  /** wait_agents returns after this at the latest. */
  waitSeconds: 600,
  /** Reports finishing within this window reach the master as one message. */
  deliveryDelayMs: 2000,
} as const;

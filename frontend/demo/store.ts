import { defaultSiteSettings, type SiteSettings } from "../src/site/settings";
import type { Approval, DevHost, Message, Project, Session, Slot, Turn, User } from "../src/types";
import { createFixtures } from "./fixtures";

export interface DemoMessage extends Message {
  session_id: string;
}

export interface DemoQuestion {
  id: string;
  session_id: string;
  questions: { id: string; header: string; question: string; multiSelect?: boolean; options?: { label: string; description: string }[] }[];
}

export interface DemoState {
  signedIn: boolean;
  user: User;
  users: User[];
  slots: Slot[];
  hosts: DevHost[];
  projects: Project[];
  sessions: Session[];
  messages: DemoMessage[];
  turns: Turn[];
  approvals: Approval[];
  questions: DemoQuestion[];
  siteSettings: SiteSettings;
  siteAccess: { publicUrls: string[]; localOrigins: string[]; revision: number };
}

export const db: DemoState = {
  signedIn: true,
  siteSettings: structuredClone(defaultSiteSettings),
  siteAccess: { publicUrls: [location.origin], localOrigins: [], revision: 1 },
  approvals: [],
  questions: [],
  ...createFixtures(),
};

export function timestamp(offsetMinutes = 0): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

export function findSession(id: string): Session | undefined {
  return db.sessions.find((session) => session.id === id);
}

export function touchSession(id: string, changes: Partial<Session>): Session | undefined {
  const session = findSession(id);
  if (session) Object.assign(session, changes, { updated_at: timestamp() });
  return session;
}

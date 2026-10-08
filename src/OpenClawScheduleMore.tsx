import type { Peer } from "./api";

export type ClawJob = {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: string;
  nextRunAt: number;
  lastRunAt: number;
  status: string;
  error: string;
  delivery: string;
};
// Edit and past runs of one schedule, inside its card.
export function ClawScheduleMore(_: { peer: Peer; job: ClawJob; canEdit: boolean; onChanged: () => void }) {
  return null;
}

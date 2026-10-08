export const CONTINUE_PRIORITY: string[];
export function canContinue(agent: string): boolean;
export function continueUnavailable(agent: string, health?: { agent: string; installed: boolean; signedIn?: boolean; connected?: boolean; canTakeMoves?: boolean; usable?: boolean }[]): string;
export function checkContinuePriority(priority: unknown): string[];

export type QuestionReply = { questionItemId: string; question: string; answer: string };
export type QuestionReplyItem = { id: string; text: string; questions?: { answer?: string }[]; replies?: QuestionReply[] };
export function questionKey(itemId: string, index: number): string;
export function questionReply(replies: QuestionReply | QuestionReply[]): string;
export function readQuestionReply(text: unknown): QuestionReply[] | null;
export function withQuestionReplies<T extends QuestionReplyItem>(items: T[]): T[];

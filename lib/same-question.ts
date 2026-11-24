// Two wordings of one question that differ only in case, spacing or punctuation are the same question.
export const sameQuestionKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

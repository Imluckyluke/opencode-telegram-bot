export interface QuestionOption {
  label: string;
  description: string;
  /** What is sent to OpenCode for this choice when it differs from the text shown (V2 only). */
  value?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  /** Whether a custom answer is accepted; unstated means accepted. */
  custom?: boolean;
}

export interface QuestionAnswer {
  question: string;
  answer: string;
}

export interface QuestionState {
  questions: Question[];
  currentIndex: number;
  selectedOptions: Map<number, Set<number>>;
  customAnswers: Map<number, string>;
  customInputQuestionIndex: number | null;
  activeMessageId: number | null;
  messageIds: number[];
  isActive: boolean;
  requestID: string | null;
}

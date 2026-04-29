export { getLearningStore, LearningStore } from './learning-store.js';
export type { LearnedPattern, PatternMatch, TaskOutcome } from './learning-store.js';
export { extractPattern, type TaskExecutionTrace } from './pattern-extractor.js';
export { buildLearningContext, recordPatternOutcomes, type LearningContext } from './prompt-injector.js';

// Explicit source/mock factory entry. Importing it never applies a plugin or
// discovers private sources; the trusted test composition supplies all seams.
export { createIamService } from './service.mjs';
export { createIamViewObserver } from './iam-view-observer.mjs';
export { createIamViewConsumer } from './iam-view-consumer.mjs';

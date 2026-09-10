/**
 * Core/main-side path to the clone-notice decider. The IMPLEMENTATION lives in
 * `@shared/project-capability-consent` because the renderer raises the dialog and may not import
 * `src/core`; this re-export exists so core/main callers (agent-messaging PR 6 Task 6.2 among
 * them) have a core-local name without a second implementation.
 * `project-capability-consent.test.ts` pins that both paths are the same function objects.
 */
export {
  capabilityAnswerOf,
  needsCapabilityNotice,
  projectCapabilityGranted,
  projectCapabilityGrantedFor,
  rearmDefaultCapabilityAcks,
  recordCapabilityAck,
  type CapabilityAckMap,
  type CapabilityAckSourceMap,
  type CapabilityAnswer,
  type CapabilityConsentState
} from '../shared/project-capability-consent'

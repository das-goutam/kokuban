/**
 * Learner model: one Bayesian knowledge tracing (BKT) estimate per micro-module.
 *
 * P(L) is the probability that the student has mastered the module. A check
 * answer updates it by Bayes' rule, then a learning transition is applied:
 *
 *   P(L | correct) = P(L)(1 - S) / [ P(L)(1 - S) + (1 - P(L)) G ]
 *   P(L | wrong)   = P(L) S      / [ P(L) S      + (1 - P(L))(1 - G) ]
 *   P(L')          = P(L | obs) + (1 - P(L | obs)) T
 *
 * with guess G, slip S and learning rate T. The values below are untuned
 * placeholders; fit them from session logs once there are some.
 *
 * In this PoC the estimate is informational (shown in the roadmap). The gate
 * that lets a student advance is a passed check, enforced by the engine.
 */
export const BKT = { guess: 0.2, slip: 0.1, learn: 0.3, mastered: 0.95 };

/** Prior P(L0): lower for a module that repairs a prerequisite the student missed. */
export const initialMastery = (isPrerequisiteGap) => (isPrerequisiteGap ? 0.15 : 0.3);

export function bktUpdate(pL, correct, { guess, slip, learn } = BKT) {
  const posterior = correct
    ? (pL * (1 - slip)) / (pL * (1 - slip) + (1 - pL) * guess)
    : (pL * slip) / (pL * slip + (1 - pL) * (1 - guess));
  return posterior + (1 - posterior) * learn;
}

export function createUltragoalResumeSignal({
  event,
  goalId = "G005",
  observedAt = new Date().toISOString(),
  jobId = null,
  runId = null,
  status = "unknown",
  profiles = [],
  completion = null
} = {}) {
  const availableProfiles = profiles
    .filter((profile) => profile?.available)
    .map(({ id, cdpUrl, headless }) => ({ id, cdpUrl, headless }));
  const requiresGoalResume = event === "provider-available" || event === "production-complete";
  return {
    schemaVersion: 1,
    kind: "ultragoal-resume-request",
    goalId,
    event,
    observedAt,
    requiresGoalResume,
    nextAction: requiresGoalResume
      ? event === "production-complete" ? "resume_ultragoal_for_quality_gate" : "resume_ultragoal_and_continue_gemini"
      : "wait_for_quota_or_human_verification",
    jobId,
    runId,
    status,
    availableProfiles,
    completion
  };
}

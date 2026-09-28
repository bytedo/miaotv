// Image publishing is a separate, explicit action on the public repository.
function shouldPublish(env) {
  return (
    env.REPOSITORY === 'bytedo/miaotv' &&
    env.EVENT_NAME === 'workflow_dispatch' &&
    env.GIT_REF === 'refs/heads/main' &&
    env.INPUT_PUBLISH === 'true'
  );
}

module.exports = { shouldPublish };

if (require.main === module) {
  process.stdout.write(String(shouldPublish(process.env)));
}

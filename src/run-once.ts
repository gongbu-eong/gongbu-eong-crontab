import { closePool } from "./db/pool";
import { scheduledJobs } from "./jobs/registry";

async function main(): Promise<void> {
  const requestedName = process.argv[2] ?? "alio-active-sync";
  const job = scheduledJobs.find(({ name }) => name === requestedName);

  if (!job) {
    throw new Error(
      `등록되지 않은 작업입니다: ${requestedName}. 사용 가능: ${scheduledJobs
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }

  try {
    const result = await job.execute();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    process.exitCode = 1;
    throw error;
  } finally {
    await closePool();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
});

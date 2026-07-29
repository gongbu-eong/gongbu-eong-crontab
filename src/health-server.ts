import { createServer, type Server } from "node:http";

import { env } from "./config";
import { scheduledJobs } from "./jobs/registry";
import { logger } from "./logger";
import type { JobScheduler } from "./scheduler";

function isAuthorized(authorizationHeader: string | undefined): boolean {
  return (
    !env.manualRunToken ||
    authorizationHeader === `Bearer ${env.manualRunToken}`
  );
}

function assertSafeConfiguration(): void {
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

  if (!loopbackHosts.has(env.serverHost) && !env.manualRunToken) {
    throw new Error(
      "외부 주소에서 수동 실행 API를 열려면 CRON_MANUAL_RUN_TOKEN이 필요합니다.",
    );
  }
}

function jobSummaries() {
  return scheduledJobs.map((job) => ({
    name: job.name,
    enabled: job.enabled,
    manualOnly: job.schedule === null,
    schedule: job.schedule,
    timezone: job.timezone,
  }));
}

export function startHealthServer(
  scheduler: JobScheduler,
): Promise<Server> {
  assertSafeConfiguration();

  const server = createServer((request, response) => {
    const pathname = new URL(
      request.url ?? "/",
      `http://${env.serverHost}:${env.serverPort}`,
    ).pathname;

    if (request.method === "GET" && pathname === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify({
          status: "ok",
          service: "gongbu-eong-crontab",
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          jobs: jobSummaries(),
        }),
      );
      return;
    }

    if (request.method === "GET" && pathname === "/jobs") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ jobs: jobSummaries() }));
      return;
    }

    const manualRunMatch = pathname.match(/^\/jobs\/([a-zA-Z0-9_-]+)\/run$/);
    if (manualRunMatch) {
      if (request.method !== "POST") {
        response.writeHead(405, {
          "Content-Type": "application/json; charset=utf-8",
          Allow: "POST",
        });
        response.end(JSON.stringify({ message: "POST 요청만 허용됩니다." }));
        return;
      }

      if (!isAuthorized(request.headers.authorization)) {
        response.writeHead(401, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ message: "Unauthorized" }));
        return;
      }

      const jobName = manualRunMatch[1];
      const result = scheduler.runNow(jobName);

      if (result === "not-found") {
        response.writeHead(404, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            message: "등록되지 않은 작업입니다.",
            job: jobName,
            availableJobs: scheduledJobs.map((job) => job.name),
          }),
        );
        return;
      }

      if (result === "already-running") {
        response.writeHead(409, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            message: "이미 실행 중인 작업입니다.",
            job: jobName,
          }),
        );
        return;
      }

      response.writeHead(202, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          message: "작업 실행을 요청했습니다.",
          job: jobName,
        }),
      );
      return;
    }

    response.writeHead(404, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ message: "Not Found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(env.serverPort, env.serverHost, () => {
      server.off("error", reject);
      logger.info("상태 확인 서버 시작", {
        host: env.serverHost,
        port: env.serverPort,
        healthUrl: `http://${env.serverHost}:${env.serverPort}/health`,
      });
      resolve(server);
    });
  });
}

export function stopHealthServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

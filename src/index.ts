import { handleCloudflareAlert } from "./api/cloudflare-alert";
import { createProcessAlertDependencies } from "./config/dependencies";
import { parseEnv } from "./config/env";
import { processHostAlert } from "./pipeline/process-alert";
import { handleQueueBatch } from "./pipeline/queue-handler";

const worker: ExportedHandler<CloudflareWorkerEnv> = {
  fetch(request, env) {
    return handleCloudflareAlert(request, env);
  },

  async queue(batch, env) {
    const config = parseEnv(env);
    const dependencies = createProcessAlertDependencies(config);
    await handleQueueBatch(batch, {
      processMessage: (message) => processHostAlert(message, dependencies),
      clock: { now: () => new Date() },
      logger: dependencies.logger,
    });
  },
};

export default worker;

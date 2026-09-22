import { GatewayServer, type ServerOptions } from './gateway/server.js';
import { Runtime, type RuntimeOptions, type RuntimeStartOptions } from './runtime.js';

export interface StartGatewayOptions extends RuntimeOptions, ServerOptions, RuntimeStartOptions {}

export interface RunningGateway {
  runtime: Runtime;
  server: GatewayServer;
  url: string;
  port: number;
  stop(): Promise<void>;
}

/** Create the runtime, bind the server, start channels/cron/heartbeat. */
export async function startGateway(options: StartGatewayOptions = {}): Promise<RunningGateway> {
  const { controlUiDir, host, port, channels, cron, heartbeat, ...runtimeOptions } = options;
  const runtime = await Runtime.create(runtimeOptions);
  const server = new GatewayServer(runtime, {
    ...(controlUiDir !== undefined && { controlUiDir }),
    ...(host !== undefined && { host }),
    ...(port !== undefined && { port }),
  });
  try {
    await server.listen();
  } catch (error) {
    await runtime.stop();
    throw error;
  }
  await runtime.start({
    ...(channels !== undefined && { channels }),
    ...(cron !== undefined && { cron }),
    ...(heartbeat !== undefined && { heartbeat }),
  });
  return {
    runtime,
    server,
    url: server.url,
    port: server.port,
    stop: async () => {
      await runtime.stop();
      await server.close();
    },
  };
}

import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  NINE_ROUTER: DurableObjectNamespace<NineRouter>;

  // wrangler.jsonc "vars"
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  BASE_URL: string;

  // `wrangler secret put <NAME>`
  INITIAL_PASSWORD: string;
  JWT_SECRET: string;
  API_KEY_SECRET: string;
  MACHINE_ID_SALT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

const PORT = 20128;

// First boot restores the SQLite DB from R2 and then starts Next.js, so allow far
// more than the library's default ~8s before giving up on the port.
const PORT_READY_TIMEOUT_MS = 120_000;

export class NineRouter extends Container<Env> {
  defaultPort = PORT;
  requiredPorts = [PORT];

  // Idle time before the container is stopped. On stop, Litestream flushes to R2
  // (the container gets SIGTERM and up to 15 min to exit), and the next request
  // cold-starts and restores. Raise this if the cold start annoys your CLI tools.
  sleepAfter = "30m";

  // Needed for upstream AI providers (OAuth, API calls) and for Litestream -> R2.
  enableInternet = true;

  pingEndpoint = "localhost/api/health";

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: "0.0.0.0",
      DATA_DIR: "/app/data",
      NEXT_TELEMETRY_DISABLED: "1",

      // Internet-facing defaults (same as upstream's Render template).
      REQUIRE_API_KEY: "true",
      AUTH_COOKIE_SECURE: "true",
      BASE_URL: env.BASE_URL,
      NEXT_PUBLIC_BASE_URL: env.BASE_URL,

      INITIAL_PASSWORD: env.INITIAL_PASSWORD,
      JWT_SECRET: env.JWT_SECRET,
      API_KEY_SECRET: env.API_KEY_SECRET,
      MACHINE_ID_SALT: env.MACHINE_ID_SALT,

      // Read by start.sh / litestream.yml inside the container.
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      R2_BUCKET: env.R2_BUCKET,
      LITESTREAM_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      LITESTREAM_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if ((await this.getState()).status !== "healthy") {
      await this.startAndWaitForPorts({
        ports: PORT,
        cancellationOptions: { portReadyTimeoutMS: PORT_READY_TIMEOUT_MS },
      });
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Single instance: 9router keeps its state in one SQLite file.
    return getContainer(env.NINE_ROUTER, "main").fetch(request);
  },
} satisfies ExportedHandler<Env>;

import denoConfig from "../deno.json" with { type: "json" };

export const SUPERCTL_VERSION = denoConfig.version;

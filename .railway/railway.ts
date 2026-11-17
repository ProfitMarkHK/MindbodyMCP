import { defineRailway, service } from "railway/iac";

// Railway Infrastructure as Code; replaces railway.json, which Railway ignores for
// new services and stops reading on 2026-12-01. Apply with `railway config apply`.
// Manages only the mindbody-mcp service's build and deploy settings. Variables and
// custom domains are per deployment and stay in Railway (see docs/RAILWAY.md).
export const partial = "mindbody-mcp";

export default defineRailway((ctx, project) => {
  const mindbodyMcp = service("mindbody-mcp", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/health",
    healthcheckTimeout: 60,
    deploy: {
      sleepApplication: true,
      // Must exceed SHUTDOWN_GRACE_MS (25 s) in src/httpServer.ts.
      drainingSeconds: 30,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
  });

  return project(ctx.projectName ?? "mindbody-mcp", {
    variables: { managed: false },
    resources: [mindbodyMcp],
  });
});
